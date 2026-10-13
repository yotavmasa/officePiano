import io,json,subprocess,sys,time,threading,os,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
os.chdir(ROOT)
sys.path.insert(0,str(ROOT/'vendor'))
import mido
r=ROOT
build=ROOT/'.build';build.mkdir(exist_ok=True)
subprocess.run(['swiftc','-module-cache-path',str(build/'swift-cache'),str(ROOT/'tests/fixtures/receiver.swift'),'-o',str(build/'receiver')],check=True)
engine=subprocess.Popen([str(r/'native/midi')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
receiver=None
try:
 def call(**data):
  engine.stdin.write(json.dumps(data)+'\n');engine.stdin.flush();return json.loads(engine.stdout.readline())
 assert not call(action='seek',seconds=1)['ok']
 receiver=subprocess.Popen([str(build/'receiver')],stdout=subprocess.PIPE,text=True)
 device=int(receiver.stdout.readline().split()[1]);packets=[]
 threading.Thread(target=lambda:[packets.append(line) for line in receiver.stdout],daemon=True).start()
 score=mido.MidiFile();track=mido.MidiTrack();score.tracks.append(track)
 track.extend([mido.MetaMessage('set_tempo',tempo=500000),mido.Message('note_on',note=60,velocity=60),mido.Message('note_off',note=60,time=1920),mido.MetaMessage('set_tempo',tempo=1000000),mido.Message('note_on',note=64,velocity=60),mido.Message('note_off',note=64,time=1920)])
 path=(build/'seek.mid').resolve();score.save(str(path))
 assert call(action='load',path=str(path))['ok']
 state=call(action='seek',seconds=3)
 assert state['ok'] and state['paused'] and not state['playing'],state
 assert abs(state['beat']-5)<.01 and abs(state['seconds']-3)<.01 and abs(state['duration_seconds']-6)<.01,state
 assert not call(action='seek',seconds=-1)['ok']
 assert not call(action='seek',seconds='bad')['ok']
 for _ in range(20):
  if any(d['id']==device for d in call(action='status')['devices']):break
  time.sleep(.1)
 state=call(action='play',device=device)
 assert state['playing'] and abs(state['seconds']-3)<.15,state
 state=call(action='seek',seconds=.5)
 assert state['playing'] and abs(state['seconds']-.5)<.15,state
 assert call(action='pause')['paused']
 state=call(action='seek',seconds=4)
 assert state['paused'] and not state['playing'] and abs(state['seconds']-4)<.01,state
 state=call(action='seek',seconds=999)
 assert state['seconds']==state['duration_seconds'] and not state['playing'],state
 assert call(action='stop')['seconds']==0
 print('PASS: tempo-aware seek, ready/playing/paused, bounds, validation, stop.')
finally:
 engine.terminate();engine.wait()
 if receiver:receiver.terminate();receiver.wait()
