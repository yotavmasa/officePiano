import Foundation
import CoreMIDI
var client = MIDIClientRef(), endpoint = MIDIEndpointRef()
let a = MIDIClientCreate("Piano Remote Test" as CFString, nil, nil, &client)
let b = MIDIDestinationCreateWithBlock(client, "Piano Remote Test Receiver" as CFString, &endpoint) { list, _ in
    let raw = UnsafeRawPointer(list).advanced(by: MemoryLayout<MIDIPacketList>.offset(of: \.packet)!)
    var packet = raw.assumingMemoryBound(to: MIDIPacket.self)
    for _ in 0..<list.pointee.numPackets {
        let rawData = UnsafeRawPointer(packet).advanced(by: MemoryLayout<MIDIPacket>.offset(of: \.data)!)
        let bytes = Array(UnsafeBufferPointer(start: rawData.assumingMemoryBound(to: UInt8.self), count: Int(packet.pointee.length)))
        print(bytes.map { String($0) }.joined(separator: ",")); fflush(stdout)
        packet = UnsafePointer(MIDIPacketNext(packet))
    }
}
print("READY \(endpoint) \(a) \(b)"); fflush(stdout)
RunLoop.current.run()
