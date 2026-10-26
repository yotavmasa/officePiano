import Foundation
import CoreMIDI
import CoreBluetooth
import AudioToolbox

struct Failure: Error { let message: String }
func check(_ status: OSStatus) throws {
    if status != noErr { throw Failure(message: "macOS MIDI error \(status)") }
}
var client = MIDIClientRef(), port = MIDIPortRef()
try check(MIDIClientCreate("Piano Remote" as CFString, nil, nil, &client))
try check(MIDIOutputPortCreate(client, "Playback" as CFString, &port))
let settingsLock = NSLock()
var selectedEndpoint = MIDIEndpointRef()
var loudness = 100
var lastDeliveryError: OSStatus = noErr
var deliveryError: OSStatus {
    get { settingsLock.lock(); defer { settingsLock.unlock() }; return lastDeliveryError }
    set { settingsLock.lock(); lastDeliveryError = newValue; settingsLock.unlock() }
}
var endpoint: MIDIEndpointRef {
    get { settingsLock.lock(); defer { settingsLock.unlock() }; return selectedEndpoint }
    set { settingsLock.lock(); selectedEndpoint = newValue; settingsLock.unlock() }
}
var volume: Int {
    get { settingsLock.lock(); defer { settingsLock.unlock() }; return loudness }
    set { settingsLock.lock(); loudness = newValue; settingsLock.unlock() }
}
var sequence: MusicSequence?, player: MusicPlayer?
var relayEndpoint = MIDIEndpointRef()
let relayLock = NSLock()
var runningStatus: UInt8 = 0
var dataIndex = 0
var inSysEx = false
var controller: UInt8 = 0
func relay(_ list: UnsafePointer<MIDIPacketList>) {
    relayLock.lock(); defer { relayLock.unlock() }
    let target = endpoint, gain = volume
    guard target != 0 else { return }
    let raw = UnsafeRawPointer(list).advanced(by: MemoryLayout<MIDIPacketList>.offset(of: \.packet)!)
    var packet = raw.assumingMemoryBound(to: MIDIPacket.self)
    for _ in 0..<list.pointee.numPackets {
        let data = UnsafeRawPointer(packet).advanced(by: MemoryLayout<MIDIPacket>.offset(of: \.data)!)
        let incoming = Array(UnsafeBufferPointer(start: data.assumingMemoryBound(to: UInt8.self), count: Int(packet.pointee.length)))
        // Song files must not send manufacturer commands to the piano.
        var bytes: [UInt8] = []
        for byte in incoming {
            if byte == 0xF0 { inSysEx = true; runningStatus = 0; dataIndex = 0; continue }
            if byte == 0xF7 { inSysEx = false; continue }
            if inSysEx && byte < 0xF8 { continue }
            bytes.append(byte)
        }
        if bytes.isEmpty { packet = UnsafePointer(MIDIPacketNext(packet)); continue }
        for index in bytes.indices {
            let byte = bytes[index]
            if byte >= 0xF8 { continue }
            if byte >= 0x80 {
                if byte == 0xF0 { inSysEx = true }
                if byte == 0xF7 { inSysEx = false }
                runningStatus = byte < 0xF0 ? byte : 0
                dataIndex = 0
                continue
            }
            guard !inSysEx, runningStatus != 0 else { continue }
            if runningStatus & 0xF0 == 0x90 && dataIndex == 1 && byte > 0 {
                // A mute suppresses new strikes even if hardware ignores CC7=0.
                if gain == 0 { bytes[index] = 0 }
            }
            if runningStatus & 0xF0 == 0xB0 {
                if dataIndex == 0 { controller = byte }
                else if controller == 7 { bytes[index] = UInt8((gain * 127 + 50) / 100) }
                else if controller == 39 { bytes[index] = 0 }
            }
            let count = (runningStatus & 0xF0 == 0xC0 || runningStatus & 0xF0 == 0xD0) ? 1 : 2
            dataIndex = (dataIndex + 1) % count
        }
        let capacity = bytes.count + 64
        let storage = UnsafeMutableRawPointer.allocate(byteCount: capacity, alignment: MemoryLayout<MIDIPacketList>.alignment)
        let output = storage.bindMemory(to: MIDIPacketList.self, capacity: 1)
        let first = MIDIPacketListInit(output)
        bytes.withUnsafeBufferPointer { buffer in
            _ = MIDIPacketListAdd(output, capacity, first, packet.pointee.timeStamp, bytes.count, buffer.baseAddress!)
        }
        let sent = MIDISend(port, target, output)
        if sent != noErr { deliveryError = sent }
        storage.deallocate()
        packet = UnsafePointer(MIDIPacketNext(packet))
    }
}
try check(MIDIDestinationCreateWithBlock(client, "Piano Remote Loudness" as CFString, &relayEndpoint) { list, _ in relay(list) })
var length: MusicTimeStamp = 0
var paused = false
func stableName(_ name: String) -> String {
    var result = name.trimmingCharacters(in: .whitespacesAndNewlines)
    for suffix in [" MIDI Bluetooth", " MIDI"] {
        if result.lowercased().hasSuffix(suffix.lowercased()) { result = String(result.dropLast(suffix.count)) }
    }
    return result
}
func destinations() -> [[String: Any]] {
    (0..<MIDIGetNumberOfDestinations()).compactMap { index in
        let dest = MIDIGetDestination(index)
        guard dest != relayEndpoint else { return nil }
        var offline: Int32 = 0
        if MIDIObjectGetIntegerProperty(dest, kMIDIPropertyOffline, &offline) == noErr && offline != 0 { return nil }
        var name: Unmanaged<CFString>?
        MIDIObjectGetStringProperty(dest, kMIDIPropertyDisplayName, &name)
        let display = name?.takeRetainedValue() as String? ?? "MIDI device"
        if bluetooth.suppressesEndpoint(display) { return nil }
        return ["id": Int(dest), "name": display, "stableName": stableName(display)]
    }
}
// This controller runs exclusively on the main run loop, like request handling.
final class PianoBluetooth: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    let service = CBUUID(string: "03B80E5A-EDE8-4B33-A751-6CE34EC4C700")
    var central: CBCentralManager?
    var peripheral: CBPeripheral?
    var preferred = ""
    var state = "idle"
    var message = "Choose your piano to enable automatic reconnection."
    var failures = 0
    var nextAttempt = Date.distantPast
    var connectingSince: Date?
    var timer: Timer?
    var handedOff = false
    var initializedAt: Date?
    var recovering = false
    var recoveryActivated = false
    var driverResetPending = false
    var locallyConnected = false
    let ioCharacteristic = CBUUID(string: "7772E5DB-3868-4112-A1A9-F2669D106BF3")
    var midiIOReady = false
    var activationStarted: Date?
    func suppressesEndpoint(_ name: String) -> Bool { recovering && matches(name) }
    func forceReconnect(_ name: String) throws {
        guard #available(macOS 13.0, *) else { throw Failure(message: "Automatic reconnection requires macOS 13 or later. Connect in Audio MIDI Setup.") }
        stop(); endpoint = 0; deliveryError = noErr
        choose(name)
        recovering = true; recoveryActivated = false; driverResetPending = true
        locallyConnected = false; handedOff = false; connectingSince = nil
        midiIOReady = false; activationStarted = nil
        failures = 0; nextAttempt = .distantPast
        if let central, central.state == .poweredOn {
            central.stopScan()
            if let known = central.retrieveConnectedPeripherals(withServices: [service]).first(where: { matches($0.name) }) ?? peripheral {
                resetDriver(known)
                return
            }
        }
        state = "searching"
        message = "Looking for \(preferred) to restore MIDI. Keep the piano on and disconnect other phones or apps using it."
        maintain()
    }
    func resetDriver(_ found: CBPeripheral) {
        guard let central, #available(macOS 13.0, *) else { return }
        // The UUID comes only from the exact selected peripheral, never a MIDI object ID.
        let result = MIDIBluetoothDriverDisconnect(found.identifier.uuidString as CFString)
        if found.state == .connected || found.state == .connecting { central.cancelPeripheralConnection(found) }
        peripheral = found; locallyConnected = false; driverResetPending = false
        midiIOReady = false; activationStarted = nil
        connectingSince = nil; handedOff = false
        nextAttempt = Date().addingTimeInterval(1)
        state = "waiting"
        message = result == noErr ? "Restoring the piano MIDI connection…" : "Retrying the selected piano connection (MIDI reset \(result))…"
    }
    var authorization: String {
        switch CBManager.authorization {
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .allowedAlways: return "allowedAlways"
        @unknown default: return "unknown"
        }
    }
    var centralState: String {
        guard let central else { return "idle" }
        switch central.state {
        case .unknown: return "unknown"
        case .resetting: return "resetting"
        case .unsupported: return "unsupported"
        case .unauthorized: return "unauthorized"
        case .poweredOff: return "poweredOff"
        case .poweredOn: return "poweredOn"
        @unknown default: return "unknown"
        }
    }
    var reconnectReady: Bool { central?.state == .poweredOn && CBManager.authorization == .allowedAlways }
    var online: Bool {
        guard !preferred.isEmpty else { return false }
        // Inspect raw MIDI state; the public destination list hides stale recovery routes.
        return (0..<MIDIGetNumberOfDestinations()).contains { index in
            let dest = MIDIGetDestination(index)
            guard dest != relayEndpoint else { return false }
            var offline: Int32 = 0
            // Some BLE driver endpoints omit this inherited property. Only an explicit
            // offline value excludes an otherwise enumerated matching destination.
            if MIDIObjectGetIntegerProperty(dest, kMIDIPropertyOffline, &offline) == noErr && offline != 0 { return false }
            var name: Unmanaged<CFString>?
            guard MIDIObjectGetStringProperty(dest, kMIDIPropertyDisplayName, &name) == noErr else { return false }
            return matches(name?.takeRetainedValue() as String?)
        }
    }
    func matches(_ name: String?) -> Bool {
        guard let name else { return false }
        return stableName(name).caseInsensitiveCompare(preferred) == .orderedSame
    }
    func choose(_ name: String) {
        let normalized = stableName(name)
        guard !normalized.isEmpty else { return }
        if preferred != normalized {
            // Never cancel an existing piano connection when changing the preference.
            peripheral = nil; connectingSince = nil; handedOff = false
            recovering = false; recoveryActivated = false; driverResetPending = false; locallyConnected = false
            preferred = normalized; failures = 0; nextAttempt = .distantPast
        }
        if central == nil {
            state = "starting"; message = "Preparing Bluetooth MIDI…"
            initializedAt = Date()
            central = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: false])
            timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.maintain() }
        }
        maintain()
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) { maintain() }
    func maintain() {
        guard let central, !preferred.isEmpty else { return }
        // CoreMIDI can already own a working connection independently of this manager.
        if online && (!recovering || (recoveryActivated && locallyConnected && peripheral?.state == .connected)) {
            recovering = false; recoveryActivated = false; driverResetPending = false
            if central.state == .poweredOn, peripheral == nil {
                // Capture the exact UUID even when Audio MIDI Setup established the connection.
                peripheral = central.retrieveConnectedPeripherals(withServices: [service]).first { matches($0.name) }
                handedOff = true
            }
            state = "connected"; failures = 0
            message = reconnectReady ? "Piano MIDI is connected. Automatic Bluetooth reconnection is ready." : "Piano MIDI is connected. Automatic Bluetooth reconnection is not ready yet."
            if central.state == .poweredOn { central.stopScan() }
            // Follow Apple's handoff only for a link this controller established.
            if central.state == .poweredOn, locallyConnected, let peripheral, peripheral.state == .connected, !handedOff {
                handedOff = true
                central.cancelPeripheralConnection(peripheral)
            }
            connectingSince = nil
            return
        }
        if CBManager.authorization == .denied || CBManager.authorization == .restricted {
            state = "denied"; message = "Allow Piano Remote Bluetooth access in System Settings → Privacy & Security → Bluetooth."; return
        }
        switch central.state {
        case .unauthorized:
            state = "denied"; message = "Allow Piano Remote Bluetooth access in System Settings → Privacy & Security → Bluetooth."; return
        case .poweredOff:
            state = "off"; message = "Turn on Mac Bluetooth to reconnect your piano."; return
        case .unsupported:
            state = "unsupported"; message = "Bluetooth MIDI is unavailable on this Mac."; return
        case .poweredOn: break
        default:
            let expired = initializedAt.map { Date().timeIntervalSince($0) > 15 } ?? false
            state = expired ? "unavailable" : "starting"
            if CBManager.authorization == .notDetermined {
                message = "Bluetooth permission is pending. Allow Piano Remote or its launcher when macOS asks; connect manually in Audio MIDI Setup meanwhile."
            } else {
                message = expired ? "Automatic Bluetooth connection is unavailable. Connect the piano in Audio MIDI Setup." : "Waiting for Bluetooth…"
            }
            return
        }
        if locallyConnected, let peripheral, peripheral.state == .connected {
            if let activationStarted, Date().timeIntervalSince(activationStarted) > 15 {
                state = "unavailable"
                message = "Bluetooth connected, but macOS did not restore piano MIDI. Open Audio MIDI Setup → Bluetooth and connect the piano, or press Reconnect to retry."
                return
            }
            if Date() >= nextAttempt {
                if midiIOReady { activate() }
                else {
                    state = "connecting"; message = "Discovering the piano MIDI service…"
                    peripheral.discoverServices([service]); nextAttempt = Date().addingTimeInterval(5)
                }
            }
            return
        }
        if let started = connectingSince {
            if Date().timeIntervalSince(started) < 25 { return }
            if let peripheral { central.cancelPeripheralConnection(peripheral) }
            retry("Piano did not connect. Retrying automatically…")
        }
        guard Date() >= nextAttempt else { return }
        let known = central.retrieveConnectedPeripherals(withServices: [service]).first { matches($0.name) }
        if let known {
            if driverResetPending { resetDriver(known) } else { connect(known) }
        } else if let peripheral {
            if driverResetPending { resetDriver(peripheral) } else { connect(peripheral) }
        } else {
            state = "searching"; message = "Looking for \(preferred). Keep the piano on and within Bluetooth range."
            if !central.isScanning { central.scanForPeripherals(withServices: [service], options: nil) }
        }
    }
    func connect(_ found: CBPeripheral) {
        guard let central, matches(found.name) || found.identifier == peripheral?.identifier else { return }
        central.stopScan(); peripheral = found; handedOff = false; connectingSince = Date()
        midiIOReady = false; activationStarted = nil
        found.delegate = self
        state = "connecting"; message = "Connecting to \(preferred)…"
        central.connect(found, options: nil)
    }
    func centralManager(_ central: CBCentralManager, didDiscover found: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard matches(found.name) || matches(advertisementData[CBAdvertisementDataLocalNameKey] as? String) else { return }
        if driverResetPending { resetDriver(found); return }
        // Advertisement names can be available before CBPeripheral.name is filled.
        if found.name == nil {
            central.stopScan(); peripheral = found; handedOff = false; connectingSince = Date()
            midiIOReady = false; activationStarted = nil; found.delegate = self
            state = "connecting"; message = "Connecting to \(preferred)…"; central.connect(found, options: nil)
        } else { connect(found) }
    }
    func activate() {
        guard midiIOReady, locallyConnected else { return }
        if #available(macOS 13.0, *) {
            let result = MIDIBluetoothDriverActivateAllConnections()
            if result == noErr {
                if activationStarted == nil { activationStarted = Date() }
                if recovering && locallyConnected { recoveryActivated = true }
                state = "connecting"; message = "Registering piano MIDI…"
                nextAttempt = Date().addingTimeInterval(3)
            } else { retry("Bluetooth MIDI registration failed (\(result)). Retrying automatically…") }
        } else {
            state = "unsupported"; message = "Automatic Bluetooth MIDI requires macOS 13 or later. Connect in Audio MIDI Setup."
        }
    }
    func centralManager(_ central: CBCentralManager, didConnect found: CBPeripheral) {
        guard found.identifier == peripheral?.identifier else { return }
        locallyConnected = true; midiIOReady = false; activationStarted = nil
        found.delegate = self
        state = "connecting"; message = "Discovering the piano MIDI service…"
        nextAttempt = Date().addingTimeInterval(5)
        found.discoverServices([service])
    }
    func peripheral(_ found: CBPeripheral, didDiscoverServices error: Error?) {
        guard found.identifier == peripheral?.identifier, locallyConnected else { return }
        guard error == nil, let midiService = found.services?.first(where: { $0.uuid == service }) else {
            state = "unavailable"; message = "Piano MIDI service discovery failed. Press Reconnect, or connect in Audio MIDI Setup."
            nextAttempt = Date().addingTimeInterval(5); return
        }
        state = "connecting"; message = "Discovering the piano MIDI input and output…"
        found.discoverCharacteristics([ioCharacteristic], for: midiService)
    }
    func peripheral(_ found: CBPeripheral, didDiscoverCharacteristicsFor discoveredService: CBService, error: Error?) {
        guard found.identifier == peripheral?.identifier, locallyConnected, discoveredService.uuid == service else { return }
        guard error == nil, discoveredService.characteristics?.contains(where: { $0.uuid == ioCharacteristic }) == true else {
            state = "unavailable"; message = "Piano MIDI input and output discovery failed. Press Reconnect, or connect in Audio MIDI Setup."
            nextAttempt = Date().addingTimeInterval(5); return
        }
        midiIOReady = true
        activate()
    }
    func retry(_ text: String) {
        connectingSince = nil; failures = min(failures + 1, 5)
        nextAttempt = Date().addingTimeInterval(min(30, pow(2, Double(failures))))
        state = "waiting"; message = text
    }
    func centralManager(_ central: CBCentralManager, didFailToConnect found: CBPeripheral, error: Error?) {
        guard found.identifier == peripheral?.identifier else { return }
        retry("Piano connection failed. Retrying automatically…")
    }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral found: CBPeripheral, error: Error?) {
        guard found.identifier == peripheral?.identifier else { return }
        locallyConnected = false; midiIOReady = false; activationStarted = nil
        if online && !recovering { state = "connected"; message = "Piano MIDI is connected."; connectingSince = nil }
        else { handedOff = false; retry("Piano disconnected. Retrying automatically…") }
    }
    var status: [String: Any] {
        maintain()
        return ["state": state, "message": message, "name": preferred,
                "authorization": authorization, "centralState": centralState, "reconnectReady": reconnectReady, "recovering": recovering]
    }
}
let bluetooth = PianoBluetooth()
func sendVolume() throws {
    var bytes: [UInt8] = []
    let value = UInt8((volume * 127 + 50) / 100)
    for channel in 0..<16 { bytes += [0xB0 | UInt8(channel), 7, value, 0xB0 | UInt8(channel), 39, 0] }
    try sendBytes(bytes)
}
func sendBytes(_ bytes: [UInt8]) throws {
    let target = endpoint
    guard target != 0 else { return }
    let storage = UnsafeMutableRawPointer.allocate(byteCount: 1024, alignment: MemoryLayout<MIDIPacketList>.alignment)
    defer { storage.deallocate() }
    let list = storage.bindMemory(to: MIDIPacketList.self, capacity: 1)
    let packet = MIDIPacketListInit(list)
    bytes.withUnsafeBufferPointer { buffer in
        _ = MIDIPacketListAdd(list, 1024, packet, 0, bytes.count, buffer.baseAddress!)
    }
    try check(MIDISend(port, target, list))
}
func panic() {
    guard endpoint != 0 else { return }
    let storage = UnsafeMutableRawPointer.allocate(byteCount: 4096, alignment: MemoryLayout<MIDIPacketList>.alignment)
    defer { storage.deallocate() }
    let ptr = storage.bindMemory(to: MIDIPacketList.self, capacity: 1)
    do {
        for channel in 0..<16 {
            let packet = MIDIPacketListInit(ptr)
            var bytes: [UInt8] = [0xB0 | UInt8(channel), 64, 0,
                                  0xB0 | UInt8(channel), 66, 0,
                                  0xB0 | UInt8(channel), 67, 0,
                                  0xB0 | UInt8(channel), 120, 0,
                                  0xB0 | UInt8(channel), 123, 0]
            // Player pianos may ignore all-notes-off; release every key explicitly.
            for note in 0..<128 { bytes += [0x80 | UInt8(channel), UInt8(note), 0] }
            bytes.withUnsafeBufferPointer { buffer in
                _ = MIDIPacketListAdd(ptr, 4096, packet, 0, bytes.count, buffer.baseAddress!)
            }
            MIDISend(port, endpoint, ptr)
        }
    }
}
func stop() {
    if let p = player { MusicPlayerStop(p); MusicPlayerSetTime(p, 0) }
    panic(); paused = false
}
func status() -> [String: Any] {
    if deliveryError != noErr { stop(); endpoint = 0 }
    if endpoint != 0 && !destinations().contains(where: { ($0["id"] as? Int) == Int(endpoint) }) {
        // Reconnection restores availability; playback requires a fresh Play action.
        stop(); endpoint = 0
    }
    var playing: DarwinBoolean = false
    var beat: MusicTimeStamp = 0
    if let p = player { MusicPlayerIsPlaying(p, &playing); MusicPlayerGetTime(p, &beat) }
    if playing.boolValue && beat >= length { stop(); beat = 0; playing = false }
    var seconds: Float64 = 0, duration: Float64 = 0
    if let s = sequence { MusicSequenceGetSecondsForBeats(s, beat, &seconds); MusicSequenceGetSecondsForBeats(s, length, &duration) }
    return ["ok": true, "playing": playing.boolValue, "paused": paused, "seconds": seconds, "duration_seconds": duration,
            "beat": beat, "length": length, "devices": destinations(), "volume": volume, "bluetooth": bluetooth.status,
            "playback_error": deliveryError == noErr ? "" : "MIDI delivery failed (\(deliveryError)). Reconnect the piano, then press Play."]
}
func handle(_ line: String) {
    do {
        guard let data = line.data(using: .utf8),
              let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let action = request["action"] as? String else { throw Failure(message: "Invalid request") }
        switch action {
        case "connect":
            guard let name = request["name"] as? String, !stableName(name).isEmpty else { throw Failure(message: "Choose a piano first") }
            bluetooth.choose(name)
        case "reconnect":
            let name = request["name"] as? String ?? bluetooth.preferred
            guard !stableName(name).isEmpty else { throw Failure(message: "Choose a piano first") }
            try bluetooth.forceReconnect(name)
        case "load":
            guard let path = request["path"] as? String else { throw Failure(message: "Missing file") }
            var replacement: MusicSequence?
            try check(NewMusicSequence(&replacement))
            guard let replacement else { throw Failure(message: "Cannot create sequence") }
            do { try check(MusicSequenceFileLoad(replacement, URL(fileURLWithPath: path) as CFURL, .midiType, [])) }
            catch { DisposeMusicSequence(replacement); throw error }
            stop()
            if let p = player { DisposeMusicPlayer(p) }; player = nil
            if let s = sequence { DisposeMusicSequence(s) }
            sequence = replacement; length = 0
            var count: UInt32 = 0
            try check(MusicSequenceGetTrackCount(replacement, &count))
            for index in 0..<count {
                var track: MusicTrack?
                try check(MusicSequenceGetIndTrack(replacement, index, &track))
                var trackLength: MusicTimeStamp = 0
                var size = UInt32(MemoryLayout<MusicTimeStamp>.size)
                try check(MusicTrackGetProperty(track!, kSequenceTrackProperty_TrackLength, &trackLength, &size))
                length = max(length, trackLength)
            }
            try check(NewMusicPlayer(&player))
            try check(MusicPlayerSetSequence(player!, replacement))
        case "play":
            guard let p = player, let s = sequence else { throw Failure(message: "Upload a MIDI file first") }
            guard let id = request["device"] as? UInt32,
                  destinations().contains(where: { ($0["id"] as? Int) == Int(id) }) else {
                throw Failure(message: "Connect Prodigy2 MIDI in Audio MIDI Setup, then refresh devices")
            }
            if endpoint != id {
                var savedBeat: MusicTimeStamp = 0
                if paused { MusicPlayerGetTime(p, &savedBeat) }
                stop(); endpoint = id
                try check(MusicPlayerSetTime(p, savedBeat))
            }
            deliveryError = noErr
            var playing: DarwinBoolean = false
            MusicPlayerIsPlaying(p, &playing)
            if !playing.boolValue {
                try sendVolume()
                try check(MusicSequenceSetMIDIEndpoint(s, relayEndpoint))
                try check(MusicPlayerPreroll(p)); try check(MusicPlayerStart(p)); paused = false
            }
        case "seek":
            guard let p = player, let s = sequence else { throw Failure(message: "Choose a song first") }
            guard let seconds = request["seconds"] as? Double, seconds.isFinite, seconds >= 0 else { throw Failure(message: "Choose a valid song time") }
            var target: MusicTimeStamp = 0
            try check(MusicSequenceGetBeatsForSeconds(s, seconds, &target))
            target = min(length, max(0, target))
            var playing: DarwinBoolean = false
            MusicPlayerIsPlaying(p, &playing)
            try check(MusicPlayerStop(p)); panic()
            try check(MusicPlayerSetTime(p, target))
            paused = !playing.boolValue
            if playing.boolValue {
                try sendVolume()
                try check(MusicPlayerPreroll(p)); try check(MusicPlayerStart(p))
            }
        case "pause":
            if let p = player {
                var playing: DarwinBoolean = false; MusicPlayerIsPlaying(p, &playing)
                if playing.boolValue { try check(MusicPlayerStop(p)); panic(); paused = true }
            }
        case "volume":
            guard let value = request["value"] as? Int, (0...100).contains(value) else {
                throw Failure(message: "Volume must be between 0 and 100")
            }
            if let id = request["device"] as? UInt32, id != 0 {
                guard destinations().contains(where: { ($0["id"] as? Int) == Int(id) }) else {
                    throw Failure(message: "Selected piano is disconnected")
                }
                if endpoint != id { stop(); endpoint = id }
            }
            volume = value
            try sendVolume()
            if value == 0 { panic() }
        case "note":
            guard let pitch = request["pitch"] as? Int, (21...108).contains(pitch),
                  let velocity = request["velocity"] as? Int, (1...127).contains(velocity),
                  let on = request["on"] as? Bool else { throw Failure(message: "Choose a valid piano key") }
            if let p = player {
                var playing: DarwinBoolean = false; MusicPlayerIsPlaying(p, &playing)
                if playing.boolValue { throw Failure(message: "Pause the song to play keys on the piano") }
            }
            guard let id = request["device"] as? UInt32,
                  destinations().contains(where: { ($0["id"] as? Int) == Int(id) }) else {
                throw Failure(message: "Connect the piano to play its keys")
            }
            if endpoint != id { stop(); endpoint = id; try sendVolume() }
            if on && volume > 0 { try sendBytes([0x90, UInt8(pitch), UInt8(velocity)]) }
            else if !on { try sendBytes([0x80, UInt8(pitch), 0]) }
        case "stop": stop()
        case "status": break
        default: throw Failure(message: "Unknown action")
        }
        let output = try JSONSerialization.data(withJSONObject: status(), options: [.sortedKeys])
        print(String(data: output, encoding: .utf8)!)
    } catch {
        let message = (error as? Failure)?.message ?? error.localizedDescription
        let output = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": message])
        print(String(data: output, encoding: .utf8)!)
    }
    fflush(stdout)
}
// CoreMIDI delivers device changes through the main run loop.
DispatchQueue.global().async {
    while let line = readLine() {
        DispatchQueue.main.sync { handle(line) }
    }
    DispatchQueue.main.async {
        stop()
        if let p = player { DisposeMusicPlayer(p) }
        if let s = sequence { DisposeMusicSequence(s) }
        MIDIPortDispose(port); MIDIClientDispose(client)
        exit(0)
    }
}
RunLoop.main.run()
