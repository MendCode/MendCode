import { cutBytesFromEnd } from "@mendcode/tools"

/** Keeps only the last `maxBytes` of appended text (FC-34: diagnostics must not grow without bound). */
export class TailBuffer {
  private text = ""

  constructor(private readonly maxBytes: number) {}

  append(chunk: string): void {
    if (chunk === "") return
    this.text = cutBytesFromEnd({ text: this.text + chunk, maxBytes: this.maxBytes })
  }

  toString(): string {
    return this.text
  }
}
