import struct
import json
import numpy as np
import shutil

clean_source_path = 'assets/glb/monster.glb'
target_raw_path = 'assets/monster_anime_bs_v01_raw.glb'
out_path_1 = 'assets/3d/monster/monster_anime_bs_v01.glb'
out_path_2 = 'assets/monster_anime_bs_v01.glb'

# 1. Load clean source skin weights
with open(clean_source_path, 'rb') as f:
    f.read(12)
    chunk_len, _ = struct.unpack('<I4s', f.read(8))
    gltf_clean = json.loads(f.read(chunk_len).decode('utf-8'))
    bin_len, _ = struct.unpack('<I4s', f.read(8))
    bin_clean = f.read(bin_len)

prim_clean = gltf_clean['meshes'][0]['primitives'][0]
acc_j0_clean = gltf_clean['accessors'][prim_clean['attributes']['JOINTS_0']]
bv_j0_clean = gltf_clean['bufferViews'][acc_j0_clean['bufferView']]
clean_j0_offset = bv_j0_clean.get('byteOffset', 0) + acc_j0_clean.get('byteOffset', 0)
clean_joints_0 = np.frombuffer(bin_clean, dtype=np.uint16, count=acc_j0_clean['count'] * 4, offset=clean_j0_offset).copy()

acc_w0_clean = gltf_clean['accessors'][prim_clean['attributes']['WEIGHTS_0']]
bv_w0_clean = gltf_clean['bufferViews'][acc_w0_clean['bufferView']]
clean_w0_offset = bv_w0_clean.get('byteOffset', 0) + acc_w0_clean.get('byteOffset', 0)
clean_weights_0 = np.frombuffer(bin_clean, dtype=np.float32, count=acc_w0_clean['count'] * 4, offset=clean_w0_offset).copy()

print(f'[Source] Loaded {len(clean_joints_0)//4} vertices of clean skin weights from {clean_source_path}')
print(f'[Source] Weights sum min: {clean_weights_0.reshape((-1, 4)).sum(axis=1).min()}, max: {clean_weights_0.reshape((-1, 4)).sum(axis=1).max()}')

# 2. Load target v01 raw GLB (contains 4.33s animation and 5 morph targets)
with open(target_raw_path, 'rb') as f:
    magic, ver, length = struct.unpack('<4sII', f.read(12))
    chunk_len, _ = struct.unpack('<I4s', f.read(8))
    gltf = json.loads(f.read(chunk_len).decode('utf-8'))
    bin_chunk_len, _ = struct.unpack('<I4s', f.read(8))
    bin_data = bytearray(f.read(bin_chunk_len))

prim = gltf['meshes'][0]['primitives'][0]
attrs = prim['attributes']
accs = gltf['accessors']
bvs = gltf['bufferViews']

# Overwrite JOINTS_0 and WEIGHTS_0 in binary buffer
acc_j0 = accs[attrs['JOINTS_0']]
bv_j0 = bvs[acc_j0['bufferView']]
j0_offset = bv_j0.get('byteOffset', 0) + acc_j0.get('byteOffset', 0)
j0_bytes = clean_joints_0.tobytes()
bin_data[j0_offset : j0_offset + len(j0_bytes)] = j0_bytes

acc_w0 = accs[attrs['WEIGHTS_0']]
bv_w0 = bvs[acc_w0['bufferView']]
w0_offset = bv_w0.get('byteOffset', 0) + acc_w0.get('byteOffset', 0)
w0_bytes = clean_weights_0.tobytes()
bin_data[w0_offset : w0_offset + len(w0_bytes)] = w0_bytes

# Update accessors min/max to match clean data
acc_j0['min'] = acc_j0_clean['min']
acc_j0['max'] = acc_j0_clean['max']
acc_w0['min'] = acc_w0_clean['min']
acc_w0['max'] = acc_w0_clean['max']

# Remove unsupported attributes and FBX junk
remove_attrs = [
    'JOINTS_1', 'JOINTS_2', 'JOINTS_3',
    'WEIGHTS_1', 'WEIGHTS_2', 'WEIGHTS_3',
    '_fbx_rotation', '_fbx_scale', '_fbx_translation',
    '_pCaptFrame', '_pCaptAlpha'
]
for ra in remove_attrs:
    if ra in attrs:
        del attrs[ra]

# Package new GLB
new_json = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
pad_len = (4 - (len(new_json) % 4)) % 4
new_json += b' ' * pad_len

bin_pad = (4 - (len(bin_data) % 4)) % 4
bin_data += b'\x00' * bin_pad

total_len = 12 + 8 + len(new_json) + 8 + len(bin_data)
hdr = struct.pack('<4sII', b'glTF', 2, total_len)
json_hdr = struct.pack('<I4s', len(new_json), b'JSON')
bin_hdr = struct.pack('<I4s', len(bin_data), b'BIN\x00')

glb_data = hdr + json_hdr + new_json + bin_hdr + bin_data

with open(out_path_1, 'wb') as f:
    f.write(glb_data)
print(f'Saved {len(glb_data)} bytes to {out_path_1}')

with open(out_path_2, 'wb') as f:
    f.write(glb_data)
print(f'Saved {len(glb_data)} bytes to {out_path_2}')

print('[Success] Transferred pristine skin weights to monster_anime_bs_v01.glb while keeping full 4.33s animation and morph targets!')
