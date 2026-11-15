#!/usr/bin/env swift
//
// Turns a photo cut-out into a die-cut sticker for a claim effect.
//
//   1. crop the transparent PNG produced by macOS subject lifting
//   2. trim the transparent margin
//   3. resize to the 2× display width
//   4. add a white border around the alpha silhouette
//
// Usage:
//   swift scripts/photo-sticker.swift <in.png> <out.png> <x> <y> <w> <h> <width> [border] [pad]
//
// The cut-out itself comes from `VNGenerateForegroundInstanceMaskRequest`
// (macOS 14+), see docs/superpowers/specs/2026-11-15-cat-sticker-design.md.

import Foundation
import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 8,
      let x = Int(args[3]), let y = Int(args[4]),
      let w = Int(args[5]), let h = Int(args[6]),
      let width = Int(args[7]) else {
    FileHandle.standardError.write(
        "usage: photo-sticker <in.png> <out.png> <x> <y> <w> <h> <width> [border] [pad]\n"
            .data(using: .utf8)!)
    exit(64)
}
let border = args.count > 8 ? (Int(args[8]) ?? 0) : 0
let pad = args.count > 9 ? (Int(args[9]) ?? 0) : 0
let inURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])

guard let source = CGImageSourceCreateWithURL(inURL as CFURL, nil),
      let photo = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let cropped = photo.cropping(to: CGRect(x: x, y: y, width: w, height: h)) else {
    FileHandle.standardError.write("cannot read/crop input\n".data(using: .utf8)!)
    exit(65)
}

// Trim the transparent margin, then scale to the requested width.
let cw = cropped.width, ch = cropped.height
var pixels = [UInt8](repeating: 0, count: cw * ch * 4)
let space = CGColorSpaceCreateDeviceRGB()
guard let probe = CGContext(
    data: &pixels, width: cw, height: ch, bitsPerComponent: 8, bytesPerRow: cw * 4,
    space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { exit(66) }
probe.draw(cropped, in: CGRect(x: 0, y: 0, width: cw, height: ch))

var minX = cw, minY = ch, maxX = -1, maxY = -1
for row in 0..<ch {
    for col in 0..<cw where pixels[(row * cw + col) * 4 + 3] > 8 {
        if col < minX { minX = col }
        if col > maxX { maxX = col }
        if row < minY { minY = row }
        if row > maxY { maxY = row }
    }
}
if maxX < 0 { exit(67) }

let boxW = maxX - minX + 1
let boxH = maxY - minY + 1
let scale = CGFloat(width) / CGFloat(boxW)
let outW = width
let outH = Int((CGFloat(boxH) * scale).rounded())
let srcY = ch - maxY - 1  // CoreGraphics measures y from the bottom
guard let trimmed = cropped.cropping(
    to: CGRect(x: minX, y: srcY, width: boxW, height: boxH)
) else { exit(68) }

guard let scaled = CGContext(
    data: nil, width: outW, height: outH, bitsPerComponent: 8, bytesPerRow: 0,
    space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { exit(69) }
scaled.interpolationQuality = .high
scaled.draw(trimmed, in: CGRect(x: 0, y: 0, width: outW, height: outH))
guard let resized = scaled.makeImage() else { exit(70) }

// Die-cut edge: dilate the alpha silhouette by `border` px and paint it white,
// then draw the photo on top.
let input = CIImage(cgImage: resized)
var final = input
if border > 0 {
    let white = CIFilter.colorMatrix()
    white.inputImage = input
    white.rVector = CIVector(x: 0, y: 0, z: 0, w: 0)
    white.gVector = CIVector(x: 0, y: 0, z: 0, w: 0)
    white.bVector = CIVector(x: 0, y: 0, z: 0, w: 0)
    white.aVector = CIVector(x: 0, y: 0, z: 0, w: 1)
    white.biasVector = CIVector(x: 1, y: 1, z: 1, w: 0)
    let dilate = CIFilter.morphologyMaximum()
    dilate.inputImage = white.outputImage
    dilate.radius = Float(border)
    if let grown = dilate.outputImage { final = input.composited(over: grown) }
}

let context = CIContext(options: [.workingColorSpace: space])
guard let out = context.createCGImage(final, from: final.extent) else { exit(71) }

// Optional transparent padding so the drop shadow has room to breathe.
let canvasW = out.width + pad * 2
let canvasH = out.height + pad * 2
guard let canvas = CGContext(
    data: nil, width: canvasW, height: canvasH, bitsPerComponent: 8, bytesPerRow: 0,
    space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { exit(72) }
canvas.clear(CGRect(x: 0, y: 0, width: canvasW, height: canvasH))
canvas.draw(out, in: CGRect(x: pad, y: pad, width: out.width, height: out.height))
guard let padded = canvas.makeImage() else { exit(73) }

guard let destination = CGImageDestinationCreateWithURL(
    outURL as CFURL, UTType.png.identifier as CFString, 1, nil
) else { exit(74) }
CGImageDestinationAddImage(destination, padded, nil)
CGImageDestinationFinalize(destination)
print("wrote \(outURL.path) \(padded.width)x\(padded.height)")
