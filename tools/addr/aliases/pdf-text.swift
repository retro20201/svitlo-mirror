// Prints the text layer of a PDF, one page after another separated by a form feed (\u{0C}).
// Usage: swift pdf-text.swift <file.pdf>          (page count goes to stderr)
// PDFKit only; no OCR. A scanned PDF prints empty pages, which verify-raw.mjs reports as such.
import Foundation
import PDFKit

guard CommandLine.arguments.count > 1,
      let doc = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else {
  FileHandle.standardError.write("cannot open PDF\n".data(using: .utf8)!)
  exit(1)
}
FileHandle.standardError.write("pages \(doc.pageCount)\n".data(using: .utf8)!)
for i in 0..<doc.pageCount {
  print(doc.page(at: i)?.string ?? "", terminator: "\u{0C}")
}
