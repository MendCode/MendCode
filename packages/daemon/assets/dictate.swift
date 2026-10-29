// MendCode dictation helper (macOS 26+): the microphone into Apple's on-device SpeechAnalyzer; no audio leaves the machine.
// Argument: a locale (`es`, `en-US`) or `auto` for the system's. JSON lines on stdout:
// {"ready":true,"locale":"es_ES"} {"installing":"es_ES"} {"level":0.42} {"text":"partial transcript"} {"final":"..."} {"error":"..."}
// It stops, finalizes and prints `final` when its input ends or on SIGINT/SIGTERM.
import AVFoundation
import Foundation
import Speech

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
    let wanted = CommandLine.arguments.dropFirst().first.flatMap { $0 == "auto" ? nil : $0 } ?? Locale.current.identifier
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: wanted)) else {
      emit(["error": "macOS has no on-device speech model for \(wanted)"]); exit(2)
    }
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
    do {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        emit(["installing": locale.identifier])
        try await request.downloadAndInstall()
      }
      guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { emit(["error": "no audio format for the speech model"]); exit(2) }
      let analyzer = SpeechAnalyzer(modules: [transcriber])
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
      let results = Task {
        var settled = ""
        for try await result in transcriber.results {
          let text = String(result.text.characters)
          if result.isFinal { settled += text; emit(["text": settled]) } else { emit(["text": settled + text]) }
        }
        return settled
      }
      try await analyzer.start(inputSequence: stream)
      try engine.start()
      emit(["ready": true, "locale": locale.identifier])
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
      emit(["final": try await results.value.trimmingCharacters(in: .whitespacesAndNewlines)])
      exit(0)
    } catch {
      emit(["error": String(describing: error).prefix(300)])
      exit(1)
    }
  }
}
