import struct
import json
import numpy as np
import shutil

raw_path = 'assets/monster_anime_bs_v01_raw.glb'
out_path_1 = 'assets/3d/monster/monster_anime_bs_v01.glb'
out_path_2 = 'assets/monster_anime_bs_v01.glb'

with open(raw_path, 'rb') as f:
    magic, ver, length = struct.unpack('<4sII', f.read(12))
    chunk_len, chunk_type = struct.unpack('<I4s', f.read(8))
    gltf = json.loads(f.read(chunk_len).decode('utf-8'))
    bin_chunk_len, bin_chunk_type = struct.unpack('<I4s', f.read(8))
    bin_data = bytearray(f.read(bin_chunk_len))

nodes = gltf['nodes']
skin = gltf['skins'][0]
joint_names = [nodes[j].get('name') for j in skin['joints']]
joint_to_idx = {name: i for i, name in enumerate(joint_names)}

prim = gltf['meshes'][0]['primitives'][0]
attrs = prim['attributes']
accs = gltf['accessors']
bvs = gltf['bufferViews']

def get_data(acc_key, is_joint=False):
    acc = accs[attrs[acc_key]]
    bv = bvs[acc['bufferView']]
    offset = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    count = acc['count']
    dt = np.uint16 if is_joint else np.float32
    n_comp = 3 if acc['type'] == 'VEC3' else 4
    return np.frombuffer(bin_data, dtype=dt, count=count * n_comp, offset=offset).reshape((count, -1))

pos = get_data('POSITION')
all_w = np.concatenate([get_data(f'WEIGHTS_{i}') for i in range(4)], axis=1)
all_j = np.concatenate([get_data(f'JOINTS_{i}', is_joint=True) for i in range(4)], axis=1)

n_verts = len(pos)

# Bone classifications
head_bones = {i for i, n in enumerate(joint_names) if any(k in n.lower() for k in ['head', 'jaw', 'ear'])}
jaw_bones = {i for i, n in enumerate(joint_names) if 'jaw' in n.lower()}
ear_bones = {i for i, n in enumerate(joint_names) if 'ear' in n.lower()}
arm_bones = {i for i, n in enumerate(joint_names) if any(k in n.lower() for k in ['clavicle', 'upperarm', 'forearm', 'hand', 'thumb', 'index', 'middle', 'ring', 'pinky'])}
arm_bones_no_clav = {i for i, n in enumerate(joint_names) if any(k in n.lower() for k in ['upperarm', 'forearm', 'hand', 'thumb', 'index', 'middle', 'ring', 'pinky'])}
leg_pelvis_bones = {i for i, n in enumerate(joint_names) if any(k in n.lower() for k in ['pelvis', 'root', 'thigh', 'calf', 'foot', 'toe', 'spine_01'])}

idx_spine_02 = joint_to_idx.get('C_spine_02', 6)
idx_spine_01 = joint_to_idx.get('C_spine_01', 5)
idx_chest = joint_to_idx.get('C_chest', 7)
idx_pelvis = joint_to_idx.get('C_pelvis', 4)
idx_head1 = joint_to_idx.get('C_head1', 30)
idx_jaw1 = joint_to_idx.get('C_jaw_01', 28)
idx_l_upperarm = joint_to_idx.get('L_upperarm', 10)
idx_r_upperarm = joint_to_idx.get('R_upperarm', 35)

new_joints_0 = np.zeros((n_verts, 4), dtype=np.uint16)
new_weights_0 = np.zeros((n_verts, 4), dtype=np.float32)

cleaned_jaw_torso = 0
cleaned_head_arms = 0
cleaned_legs_head = 0
cleaned_arms_head = 0

for vi in range(n_verts):
    p = pos[vi]
    jw = {}
    for k in range(16):
        w = float(all_w[vi, k])
        if w > 1e-5:
            j = int(all_j[vi, k])
            jw[j] = jw.get(j, 0.0) + w

    # 1. Clean head/jaw/ear influences from torso, belly, and legs (Y < 0.62)
    if p[1] < 0.62:
        for j in list(jw.keys()):
            if j in head_bones:
                w = jw.pop(j)
                cleaned_jaw_torso += 1
                if p[1] < 0.45:
                    target_j = idx_pelvis if p[1] < 0.35 else idx_spine_01
                else:
                    target_j = idx_spine_02 if p[2] < -0.1 else idx_chest
                jw[target_j] = jw.get(target_j, 0.0) + w

    # 2. Clean head/jaw/ear influences from outer arms (|X| > 0.45)
    if abs(p[0]) > 0.45:
        for j in list(jw.keys()):
            if j in head_bones:
                w = jw.pop(j)
                cleaned_head_arms += 1
                target_j = idx_l_upperarm if p[0] > 0 else idx_r_upperarm
                jw[target_j] = jw.get(target_j, 0.0) + w

    # 3. Clean lower body / legs / pelvis influences from head & jaw (Y > 0.72)
    if p[1] > 0.72:
        for j in list(jw.keys()):
            if j in leg_pelvis_bones:
                w = jw.pop(j)
                cleaned_legs_head += 1
                # If on front/bottom of face, send to jaw; else head1
                if p[1] < 0.85 and p[2] > -0.1:
                    target_j = idx_jaw1
                else:
                    target_j = idx_head1
                jw[target_j] = jw.get(target_j, 0.0) + w

    # 4. Clean arm influences from head (|X| < 0.35 and Y > 0.75)
    if abs(p[0]) < 0.35 and p[1] > 0.75:
        for j in list(jw.keys()):
            if j in arm_bones_no_clav:
                w = jw.pop(j)
                cleaned_arms_head += 1
                jw[idx_head1] = jw.get(idx_head1, 0.0) + w

    # Sort all accumulated weights descending
    sorted_items = sorted(jw.items(), key=lambda x: -x[1])
    top4 = sorted_items[:4]
    tot = sum(w for j, w in top4)

    if tot < 1e-6:
        fallback = idx_head1 if p[1] > 0.72 else (idx_chest if p[1] > 0.45 else idx_pelvis)
        new_joints_0[vi, 0] = fallback
        new_weights_0[vi, 0] = 1.0
    else:
        for idx_top, (j, w) in enumerate(top4):
            new_joints_0[vi, idx_top] = j
            new_weights_0[vi, idx_top] = w / tot

print(f'Cleaning summary:')
print(f'  Cleaned jaw/head from torso: {cleaned_jaw_torso}')
print(f'  Cleaned head/ear from arms: {cleaned_head_arms}')
print(f'  Cleaned leg/pelvis from head: {cleaned_legs_head}')
print(f'  Cleaned arm from head: {cleaned_arms_head}')

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

glb_data = hdr + json_hdr + new_json + bin_hdr + bin_data

with open(out_path_1, 'wb') as f:
    f.write(glb_data)
print(f'Saved {len(glb_data)} bytes to {out_path_1}')

with open(out_path_2, 'wb') as f:
    f.write(glb_data)
print(f'Saved {len(glb_data)} bytes to {out_path_2}')

print('Successfully cleaned skinning weights, removed extra attributes, and normalized all vertex weights!')
