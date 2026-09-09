import struct
import json
import numpy as np
import shutil

src_path = 'assets/3d/monster/monster_anime_bs.glb'
raw_backup = 'assets/3d/monster/monster_anime_bs_raw.glb'

shutil.copyfile(src_path, raw_backup)
print(f'Backed up original to {raw_backup}')

with open(src_path, 'rb') as f:
    magic, ver, length = struct.unpack('<4sII', f.read(12))
    chunk_len, chunk_type = struct.unpack('<I4s', f.read(8))
    gltf = json.loads(f.read(chunk_len).decode('utf-8'))
    bin_len, bin_type = struct.unpack('<I4s', f.read(8))
    bin_data = bytearray(f.read(bin_len))

accs = gltf['accessors']
bvs = gltf['bufferViews']
prim = gltf['meshes'][0]['primitives'][0]
attrs = prim['attributes']

def get_acc_data(acc_idx, is_joint=False):
    acc = accs[acc_idx]
    bv = bvs[acc['bufferView']]
    offset = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    count = acc['count']
    dt = np.uint16 if is_joint else np.float32
    return np.frombuffer(bin_data, dtype=dt, count=count * 4, offset=offset).reshape((count, 4))

pos_acc = accs[attrs['POSITION']]
pos_bv = bvs[pos_acc['bufferView']]
pos = np.frombuffer(bin_data, dtype=np.float32, count=pos_acc['count'] * 3, offset=pos_bv.get('byteOffset', 0)).reshape((-1, 3))

skin = gltf['skins'][0]
joint_names = [gltf['nodes'][j].get('name', '') for j in skin['joints']]
joint_to_idx = {name: i for i, name in enumerate(joint_names)}

jaw_indices = {i for i, n in enumerate(joint_names) if 'jaw' in n.lower()}
spine_idx = joint_to_idx.get('C_spine_02', joint_to_idx.get('C_spine_01', 0))

# Load all 4 sets of joints and weights
all_w = np.concatenate([get_acc_data(attrs[f'WEIGHTS_{i}']) for i in range(4)], axis=1)
all_j = np.concatenate([get_acc_data(attrs[f'JOINTS_{i}'], is_joint=True) for i in range(4)], axis=1)

n_verts = len(pos)
new_joints_0 = np.zeros((n_verts, 4), dtype=np.uint16)
new_weights_0 = np.zeros((n_verts, 4), dtype=np.float32)

for vi in range(n_verts):
    p = pos[vi]
    jw = {}
    for k in range(16):
        w = float(all_w[vi, k])
        if w > 1e-6:
            j = int(all_j[vi, k])
            # Clean stray jaw influence from lower torso/chest (Y < 0.55)
            if j in jaw_indices and p[1] < 0.55:
                j = spine_idx
            jw[j] = jw.get(j, 0.0) + w

    sorted_influences = sorted(jw.items(), key=lambda x: -x[1])
    top4 = sorted_influences[:4]
    tot = sum(w for j, w in top4)

    if tot < 1e-6:
        new_joints_0[vi, 0] = spine_idx
        new_weights_0[vi, 0] = 1.0
    else:
        for idx, (j, w) in enumerate(top4):
            new_joints_0[vi, idx] = j
            new_weights_0[vi, idx] = w / tot

# Overwrite JOINTS_0 and WEIGHTS_0 in binary buffer
bv_j0 = bvs[accs[attrs['JOINTS_0']]['bufferView']]
bv_w0 = bvs[accs[attrs['WEIGHTS_0']]['bufferView']]

j0_bytes = new_joints_0.tobytes()
w0_bytes = new_weights_0.tobytes()

bin_data[bv_j0['byteOffset'] : bv_j0['byteOffset'] + len(j0_bytes)] = j0_bytes
bin_data[bv_w0['byteOffset'] : bv_w0['byteOffset'] + len(w0_bytes)] = w0_bytes

# Update accessors min/max
acc_j0 = accs[attrs['JOINTS_0']]
acc_w0 = accs[attrs['WEIGHTS_0']]

acc_j0['min'] = [int(new_joints_0[:, c].min()) for c in range(4)]
acc_j0['max'] = [int(new_joints_0[:, c].max()) for c in range(4)]
acc_w0['min'] = [float(new_weights_0[:, c].min()) for c in range(4)]
acc_w0['max'] = [float(new_weights_0[:, c].max()) for c in range(4)]

# Remove extra unsupported joint/weight attributes and FBX junk
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

with open(src_path, 'wb') as f:
    f.write(hdr)
    f.write(json_hdr)
    f.write(new_json)
    f.write(bin_hdr)
    f.write(bin_data)

# Also copy to assets/glb/monster.glb
shutil.copyfile(src_path, 'assets/glb/monster.glb')

print('Successfully cleaned skinning weights and consolidated to top 4 normalized influences!')
