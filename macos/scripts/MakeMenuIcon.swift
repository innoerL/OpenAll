import AppKit

let image = NSImage(size: NSSize(width: 64, height: 64))
image.lockFocus()
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: 64, height: 64).fill()
let ring = NSBezierPath(ovalIn: NSRect(x: 10, y: 10, width: 44, height: 44))
ring.lineWidth = 8
NSColor.black.setStroke()
ring.stroke()
let disk = NSBezierPath()
disk.move(to: NSPoint(x: 4, y: 29))
disk.curve(to: NSPoint(x: 60, y: 35), controlPoint1: NSPoint(x: 22, y: 26), controlPoint2: NSPoint(x: 42, y: 36))
disk.lineWidth = 8
disk.lineCapStyle = .round
disk.stroke()
image.unlockFocus()
let data = NSBitmapImageRep(data: image.tiffRepresentation!)!.representation(using: .png, properties: [:])!
try data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
