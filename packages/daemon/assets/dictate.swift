// MendCode dictation helper (macOS 26+): the microphone into Apple's on-device SpeechAnalyzer; no audio leaves the machine.
// Argument: a locale (`es`, `en-US`), two (`es,en`) or `auto` for the user's preferred languages. JSON lines on stdout:
// {"ready":true,"locale":"es_ES"} {"installing":"es_ES"} {"level":0.42} {"text":"partial transcript"} {"final":"...","locale":"es_ES"} {"error":"..."}
// It stops, finalizes and prints `final` when its input ends or on SIGINT/SIGTERM.
// `--resolve <wanted> <preferred,...> <supported,...>` prints the locales it would hear with as a JSON array and touches nothing.
// `--live <locale,locale> <text> <text>` prints which language's running text it would show for those transcripts and touches nothing.
import AVFoundation
import Foundation
import NaturalLanguage
import Speech

/// At most this many languages listen at once; each is one more model in the speech service.
let MAX_LANGUAGES = 2

/// The speech models to listen with. Named locales (`es`, `es,en`) get their own models; `auto` takes the first two distinct
/// languages the user prefers (System Settings > Language & Region), not the region: a Mac set to English (Panama) with Spanish
/// second hears both. Each one maps to a supported model of the same language: the exact locale, the same region, the language's
/// likely region (`en` → US, `es` → ES), then any. Apple's own `supportedLocale(equivalentTo:)` maps en_PA to en_IE.
func resolveLocales(wanted: String, preferred: [String], supported: [String]) -> [String] {
  let candidates = wanted == "auto" ? preferred : wanted.split(separator: ",").map(String.init)
  var chosen: [String] = []
  var languages = Set<String>()
  for candidate in candidates {
    let id = candidate.replacingOccurrences(of: "-", with: "_")
    let parts = id.split(separator: "_").map(String.init)
    guard let language = parts.first?.lowercased(), !language.isEmpty, !languages.contains(language) else { continue }
    let region = parts.dropFirst().last(where: { $0.count == 2 && $0 == $0.uppercased() || $0.count == 3 && Int($0) != nil })
    let same = supported.filter { $0.split(separator: "_").first.map(String.init)?.lowercased() == language }.sorted()
    let likely = Locale(identifier: language).language.maximalIdentifier.split(separator: "-").last.map(String.init)
    let pick = same.first { $0 == id }
      ?? region.flatMap { region in same.first { $0.hasSuffix("_\(region)") } }
      ?? likely.flatMap { likely in same.first { $0.hasSuffix("_\(likely)") } }
      ?? same.first
    guard let pick else { continue }
    chosen.append(pick)
    languages.insert(language)
    if chosen.count == MAX_LANGUAGES { break }
  }
  return chosen
}

/// One language's running transcript and how sure the model is of it, so the more confident language is the one shown.
final class Heard: @unchecked Sendable {
  let locale: String
  var settled = ""
  var volatile = ""
  var weighted = 0.0
  var characters = 0.0
  init(_ locale: String) { self.locale = locale }
  var text: String { settled + volatile }
  var confidence: Double { characters > 0 ? weighted / characters : 0 }
}

/// The written language a speech model's locale produces, for telling which model is hearing its own language.
func writtenLanguage(_ locale: String) -> NLLanguage {
  let parts = locale.split(separator: "_").map(String.init)
  switch parts.first ?? "" {
  case "yue": return .traditionalChinese
  case "zh": return ["TW", "HK", "MO"].contains(parts.last ?? "") ? .traditionalChinese : .simplifiedChinese
  case let code: return NLLanguage(rawValue: code)
  }
}

/// How much of each running transcript reads as its model's own language, 0...1. Volatile results carry no confidence, but a model
/// hearing another language spells that language's sounds in its own words ("quivo de configulacóas" from Spanish on the English
/// model), and that text reads as the other language. Only the last 1000 characters count, so the cost stays flat on long dictation.
func ownLanguageShares(_ texts: [String], locales: [String]) -> [Double] {
  let languages = locales.map(writtenLanguage)
  let recognizer = NLLanguageRecognizer()
  recognizer.languageConstraints = Array(Set(languages))
  return zip(texts, languages).map { text, language in
    recognizer.reset()
    recognizer.processString(String(text.suffix(1000)))
    return recognizer.languageHypotheses(withMaximum: languages.count)[language] ?? 0
  }
}

/// The transcript to show while listening: the one that reads most as its own language; a tie keeps the one already shown so the row
/// does not flicker between languages.
func liveLeader(_ texts: [String], locales: [String], current: Int) -> Int {
  guard texts.count > 1 else { return 0 }
  let shares = ownLanguageShares(texts, locales: locales)
  var best = current
  for index in shares.indices where shares[index] > shares[best] { best = index }
  return best
}

let output = NSLock()
func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  output.lock(); defer { output.unlock() }
  FileHandle.standardOutput.write(data + Data([10]))
}

final class Once: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Void, Never>?
  init(_ continuation: CheckedContinuation<Void, Never>) { self.continuation = continuation }
  func fire() { lock.lock(); let pending = continuation; continuation = nil; lock.unlock(); pending?.resume() }
}

nonisolated(unsafe) var signalSources: [DispatchSourceSignal] = []

@main struct Dictate {
  static func main() async {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments.first == "--resolve", arguments.count == 4 {
      let list = { (value: String) in value.split(separator: ",").map(String.init) }
      emit(["locales": resolveLocales(wanted: arguments[1], preferred: list(arguments[2]), supported: list(arguments[3]))])
      exit(0)
    }
    if arguments.first == "--live", arguments.count >= 3 {
      let locales = arguments[1].split(separator: ",").map(String.init)
      let texts = Array(arguments.dropFirst(2))
      guard texts.count == locales.count else { emit(["error": "--live takes one text per locale"]); exit(2) }
      emit(["locale": locales[liveLeader(texts, locales: locales, current: 0)]])
      exit(0)
    }
    let wanted = arguments.first ?? "auto"
    let supported = await SpeechTranscriber.supportedLocales.map(\.identifier)
    let locales = resolveLocales(wanted: wanted, preferred: Locale.preferredLanguages, supported: supported)
    guard !locales.isEmpty else {
      emit(["error": "macOS has no on-device speech model for \(wanted == "auto" ? Locale.preferredLanguages.joined(separator: ", ") : wanted)"]); exit(2)
    }
    let heard = locales.map { Heard($0) }
    // `fastResults` is what Apple's live preset adds: words arrive about a second after they are said instead of only at a pause
    // or the end, and the finished transcript is the same.
    let transcribers = locales.map { SpeechTranscriber(locale: Locale(identifier: $0), transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [.transcriptionConfidence]) }
    let state = NSLock()
    // The finished transcript the models are surest of; one language is always itself.
    func leader() -> Heard { heard.max { $0.confidence < $1.confidence } ?? heard[0] }
    var shown = 0
    do {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: transcribers) {
        emit(["installing": locales.joined(separator: ",")])
        try await request.downloadAndInstall()
      }
      guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: transcribers) else { emit(["error": "no audio format for the speech model"]); exit(2) }
      let analyzer = SpeechAnalyzer(modules: transcribers)
      let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
      let engine = AVAudioEngine()
      let node = engine.inputNode
      let source = node.outputFormat(forBus: 0)
      guard source.sampleRate > 0, let converter = AVAudioConverter(from: source, to: format) else { emit(["error": "no microphone input; check the microphone and its permission"]); exit(2) }
      var lastLevel = Date.distantPast
      node.installTap(onBus: 0, bufferSize: 1024, format: source) { buffer, _ in
        if let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 {
          var sum: Float = 0
          for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
          // Speech sits around -40..-10 dBFS: map that range onto 0..1 so a normal voice fills the bars.
          let db = 20 * log10(max(1e-6, sqrt(sum / Float(buffer.frameLength))))
          if Date().timeIntervalSince(lastLevel) >= 0.04 { lastLevel = Date(); emit(["level": Double(min(1, max(0, (db + 55) / 45)))]) }
        }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / source.sampleRate) + 16
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
        var fed = false
        converter.convert(to: converted, error: nil) { _, status in
          if fed { status.pointee = .noDataNow; return nil }
          fed = true
          status.pointee = .haveData
          return buffer
        }
        if converted.frameLength > 0 { input.yield(AnalyzerInput(buffer: converted)) }
      }
      let results = zip(transcribers, heard).map { transcriber, language in
        Task {
          for try await result in transcriber.results {
            let text = String(result.text.characters)
            let shown = state.withLock {
              if result.isFinal {
                language.settled += text
                language.volatile = ""
                for run in result.text.runs {
                  guard let confidence = run.transcriptionConfidence else { continue }
                  let size = Double(result.text[run.range].characters.count)
                  language.weighted += confidence * size
                  language.characters += size
                }
              } else {
                language.volatile = text
              }
              shown = liveLeader(heard.map(\.text), locales: locales, current: shown)
              return heard[shown].text
            }
            emit(["text": shown])
          }
        }
      }
      try await analyzer.start(inputSequence: stream)
      try engine.start()
      emit(["ready": true, "locale": locales.joined(separator: ",")])
      await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
        let once = Once(done)
        for number in [SIGINT, SIGTERM] {
          signal(number, SIG_IGN)
          let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
          source.setEventHandler { once.fire() }
          source.resume()
          signalSources.append(source)
        }
        Thread.detachNewThread {
          while !FileHandle.standardInput.availableData.isEmpty {}
          once.fire()
        }
      }
      engine.stop()
      node.removeTap(onBus: 0)
      input.finish()
      try await analyzer.finalizeAndFinishThroughEndOfInput()
      for task in results { try await task.value }
      let best = state.withLock { leader() }
      emit(["final": best.settled.trimmingCharacters(in: .whitespacesAndNewlines), "locale": best.locale])
      exit(0)
    } catch {
      emit(["error": String(describing: error).prefix(300)])
      exit(1)
    }
  }
}
