// Prints a PDF table column by column, with the vertical position of every line, so rows can be put
// back together even when the page's text layer lists whole columns one after another.
//
//   swift pdf-layout.swift <file.pdf> <x0-x1> [<x0-x1> …]
//
// For every page and every column strip (PDF points, x from the left edge) it prints one line per
// text line:   page \t column \t y \t text      (y counted from the page bottom: larger = higher up).
// PDFKit only; no OCR. A scanned PDF prints nothing.
import Foundation
import PDFKit

let args = CommandLine.arguments
guard args.count > 2, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
  FileHandle.standardError.write("usage: pdf-layout.swift <file.pdf> <x0-x1> [<x0-x1> …]\n".data(using: .utf8)!)
  exit(1)
}
var columns: [(Double, Double)] = []
for spec in args.dropFirst(2) {
  let parts = spec.split(separator: "-").compactMap { Double($0) }
  guard parts.count == 2 else { FileHandle.standardError.write("bad column \(spec)\n".data(using: .utf8)!); exit(1) }
  columns.append((parts[0], parts[1]))
}
FileHandle.standardError.write("pages \(doc.pageCount)\n".data(using: .utf8)!)
for p in 0..<doc.pageCount {
  guard let page = doc.page(at: p) else { continue }
  let bounds = page.bounds(for: .mediaBox)
  for (index, column) in columns.enumerated() {
    let rect = CGRect(x: column.0, y: 0, width: column.1 - column.0, height: bounds.height)
    guard let selection = page.selection(for: rect) else { continue }
    for line in selection.selectionsByLine() {
      let text = (line.string ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
      if text.isEmpty { continue }
      let y = line.bounds(for: page).midY
      print("\(p)\t\(index)\t\(String(format: "%.1f", y))\t\(text)")
    }
  }
}
