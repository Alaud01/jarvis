import Cocoa
import CoreGraphics

private var eventTap: CFMachPort?
private var runLoopSource: CFRunLoopSource?
private var isPressed = false

private func emitFnStateIfChanged(pressed: Bool) {
    if pressed && !isPressed {
        isPressed = true
        print("down")
        fflush(stdout)
    } else if !pressed && isPressed {
        isPressed = false
        print("up")
        fflush(stdout)
    }
}

private func callback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, userInfo: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        return Unmanaged.passUnretained(event)
    }

    if type == .flagsChanged {
        let fnDown = event.flags.contains(.maskSecondaryFn)
        emitFnStateIfChanged(pressed: fnDown)
        return Unmanaged.passUnretained(event)
    }

    guard type == .keyDown || type == .keyUp else {
        return Unmanaged.passUnretained(event)
    }

    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    guard keyCode == 63 else {
        return Unmanaged.passUnretained(event)
    }

    let pressed = (type == .keyDown)
    emitFnStateIfChanged(pressed: pressed)
    return Unmanaged.passUnretained(event)
}

private func cleanup() {
    if let tap = eventTap {
        CGEvent.tapEnable(tap: tap, enable: false)
    }
    if let source = runLoopSource {
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
    }
    eventTap = nil
    runLoopSource = nil
}

private func signalHandler(_ sig: Int32) {
    cleanup()
    exit(0)
}

let mask: CGEventMask = (1 << CGEventType.keyDown.rawValue)
    | (1 << CGEventType.keyUp.rawValue)
    | (1 << CGEventType.flagsChanged.rawValue)

guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap,
                                  place: .headInsertEventTap,
                                  options: .defaultTap,
                                  eventsOfInterest: mask,
                                  callback: callback,
                                  userInfo: nil) else {
    fputs("ERROR: Could not create event tap. Grant Accessibility access in System Preferences.\n", stderr)
    exit(1)
}

eventTap = tap
runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

signal(SIGTERM, signalHandler)
signal(SIGINT, signalHandler)

print("READY")
fflush(stdout)

CFRunLoopRun()
