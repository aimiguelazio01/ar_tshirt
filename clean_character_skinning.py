import struct
import json
import numpy as np

# Load original backup
with open('assets/glb/monster_backup.glb', 'rb') as f:
    magic, version, length = struct.unpack('<4sII', f.read(12))
    chunk_len, chunk_type = struct.unpack('<I4s', f.read(8))
    gltf = json.loads(f.read(chunk_len).decode('utf-8'))
    bin_chunk_len, bin_chunk_type = struct.unpack('<I4s', f.read(8))
    bin_data = bytearray(f.read(bin_chunk_len))

nodes = gltf['nodes']
skin = gltf['skins'][0]
joint_indices = skin['joints']
joint_names = [nodes[j].get('name') for j in joint_indices]
joint_to_idx = {name: i for i, name in enumerate(joint_names)}

prim = gltf['meshes'][0]['primitives'][0]
attrs = prim['attributes']

def get_accessor_data(acc_idx):
    acc = gltf['accessors'][acc_idx]
    bv = gltf['bufferViews'][acc['bufferView']]
    offset = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    count = acc['count']
    comp_type = acc['componentType']
    type_str = acc['type']
    type_counts = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
    n_per_elem = type_counts[type_str]
    dtype = np.float32 if comp_type == 5126 else (np.uint16 if comp_type == 5123 else np.uint8)
    arr = np.frombuffer(bin_data, dtype=dtype, count=count * n_per_elem, offset=offset)
    return arr.reshape((count, n_per_elem))

pos = get_accessor_data(attrs['POSITION'])

weights_keys = sorted([k for k in attrs.keys() if k.startswith('WEIGHTS_')])
joints_keys = sorted([k for k in attrs.keys() if k.startswith('JOINTS_')])

all_weights = [get_accessor_data(attrs[k]) for k in weights_keys]
all_joints = [get_accessor_data(attrs[k]) for k in joints_keys]

total_weights = np.concatenate(all_weights, axis=1)
total_joints = np.concatenate(all_joints, axis=1)

n_verts = len(pos)

# Classify bones
head_cranium_bones = {'C_head_01', 'C_head_02'}
jaw_bones = {'C_jaw_01', 'C_jaw_02'}
ear_bones = {'L_ear_01', 'L_ear_02', 'L_ear_03', 'R_ear_01', 'R_ear_02', 'R_ear_03'}
all_head_bones = head_cranium_bones | jaw_bones | ear_bones

neck_bones = {'c_neck'}
chest_bones = {'C_spine_03'}
lower_spine_bones = {'C_spine_01', 'C_spine_02'}
pelvis_bones = {'C_pelvis', 'C_root'}
arm_bones = {'L_clavicle', 'L_upperarm', 'L_lowerarm', 'L_hand', 'L_thumb_01', 'L_thumb_02', 'L_index_01', 'L_index_02', 'L_middle_01', 'L_middle_02', 'L_pinky_01', 'L_pinky_02', 'L_ring_01', 'L_ring_02',
             'R_clavicle', 'R_upperarm', 'R_lowerarm', 'R_hand', 'R_thumb_01', 'R_thumb_02', 'R_index_01', 'R_index_02', 'R_middle_01', 'R_middle_02', 'R_pinky_01', 'R_pinky_02', 'R_ring_01', 'R_ring_02'}
leg_bones = {'L_thigh', 'L_calf', 'L_foot', 'L_ball', 'R_thigh', 'R_calf', 'R_foot', 'R_ball'}

body_bones = lower_spine_bones | pelvis_bones | arm_bones | leg_bones

# Indices
idx_all_head = {joint_to_idx[n] for n in all_head_bones}
idx_jaw = {joint_to_idx[n] for n in jaw_bones}
idx_neck = {joint_to_idx[n] for n in neck_bones}
idx_chest = {joint_to_idx[n] for n in chest_bones}
idx_lower_spine = {joint_to_idx[n] for n in lower_spine_bones}
idx_pelvis = {joint_to_idx[n] for n in pelvis_bones}
idx_arms = {joint_to_idx[n] for n in arm_bones}
idx_legs = {joint_to_idx[n] for n in leg_bones}
idx_body = {joint_to_idx[n] for n in body_bones}

new_joints_0 = np.zeros((n_verts, 4), dtype=np.uint16)
new_weights_0 = np.zeros((n_verts, 4), dtype=np.float32)

for vi in range(n_verts):
    p = pos[vi]
    w_row = total_weights[vi].copy()
    j_row = total_joints[vi].copy()
    
    jw = {}
    for k in range(len(w_row)):
        w = float(w_row[k])
        if w > 1e-5:
            j = int(j_row[k])
            jw[j] = jw.get(j, 0.0) + w

    weight_in_head = sum(w for j, w in jw.items() if j in idx_all_head)
    weight_in_jaw = sum(w for j, w in jw.items() if j in idx_jaw)
    weight_in_arms = sum(w for j, w in jw.items() if j in idx_arms)
    weight_in_lower_spine = sum(w for j, w in jw.items() if j in idx_lower_spine)
    weight_in_pelvis_legs = sum(w for j, w in jw.items() if j in (idx_pelvis | idx_legs))

    # Strict partition between head and body
    is_head_vertex = (weight_in_head > 0.35) or (p[1] > 0.70 and weight_in_head > 0.15) or (p[1] > 0.85 and abs(p[0]) < 0.45)
    is_arm_or_body = (weight_in_arms > 0.25) or (weight_in_pelvis_legs + weight_in_lower_spine > 0.25) or (p[1] < 0.65)

    if is_head_vertex and not (weight_in_arms > 0.5):
        # Clean out all body influences from head vertex
        for j in list(jw.keys()):
            w = jw[j]
            if j in idx_body:
                del jw[j]
                if weight_in_jaw > 0.2 or (p[1] < 0.8 and p[2] > 0.0):
                    target_j = joint_to_idx['C_jaw_01']
                elif p[1] < 0.95 and p[2] < -0.3:
                    target_j = joint_to_idx['c_neck']
                else:
                    target_j = joint_to_idx['C_head_01']
                jw[target_j] = jw.get(target_j, 0.0) + w

    elif is_arm_or_body:
        # Clean out all head influences from arm / body vertex
        for j in list(jw.keys()):
            w = jw[j]
            if j in idx_all_head:
                del jw[j]
                if weight_in_arms > 0.2:
                    # Pick whichever arm bone is already present, or default to clavicle
                    existing_arm = [aj for aj in jw.keys() if aj in idx_arms]
                    target_j = existing_arm[0] if existing_arm else (joint_to_idx['L_clavicle'] if p[0] > 0 else joint_to_idx['R_clavicle'])
                elif p[1] > 0.45:
                    target_j = joint_to_idx['C_spine_03']
                else:
                    target_j = joint_to_idx['C_pelvis']
                jw[target_j] = jw.get(target_j, 0.0) + w

    # Clean lower spine / pelvis from neck region
    for j in list(jw.keys()):
        w = jw[j]
        if j in (idx_lower_spine | idx_pelvis | idx_legs):
            if (joint_to_idx['c_neck'] in jw) or (joint_to_idx['C_head_01'] in jw) or (p[1] > 0.65):
                del jw[j]
                target_j = joint_to_idx['C_spine_03']
                jw[target_j] = jw.get(target_j, 0.0) + w

    # Pick top 4
    sorted_items = sorted(jw.items(), key=lambda x: -x[1])
    top4 = sorted_items[:4]
    
    tot = sum(w for j, w in top4)
    if tot < 1e-5:
        if p[1] > 0.65:
            fallback_j = joint_to_idx['C_head_01']
        elif p[1] > 0.45:
            fallback_j = joint_to_idx['C_spine_03']
        else:
            fallback_j = joint_to_idx['C_pelvis']
        new_joints_0[vi, 0] = fallback_j
        new_weights_0[vi, 0] = 1.0
    else:
        for idx_top, (j, w) in enumerate(top4):
            new_joints_0[vi, idx_top] = j
            new_weights_0[vi, idx_top] = w / tot

# Write back into binary buffer at BV 7 and BV 12
bv7 = gltf['bufferViews'][7]
bv12 = gltf['bufferViews'][12]

joints_bytes = new_joints_0.tobytes()
weights_bytes = new_weights_0.tobytes()

bin_data[bv7['byteOffset'] : bv7['byteOffset'] + len(joints_bytes)] = joints_bytes
bin_data[bv12['byteOffset'] : bv12['byteOffset'] + len(weights_bytes)] = weights_bytes

acc_joints = gltf['accessors'][attrs['JOINTS_0']]
acc_weights = gltf['accessors'][attrs['WEIGHTS_0']]

acc_joints['min'] = [int(new_joints_0[:, c].min()) for c in range(4)]
acc_joints['max'] = [int(new_joints_0[:, c].max()) for c in range(4)]
acc_weights['min'] = [float(new_weights_0[:, c].min()) for c in range(4)]
acc_weights['max'] = [float(new_weights_0[:, c].max()) for c in range(4)]

for k in ['JOINTS_1', 'JOINTS_2', 'JOINTS_3', 'JOINTS_4', 'WEIGHTS_1', 'WEIGHTS_2', 'WEIGHTS_3', 'WEIGHTS_4']:
    if k in attrs:
        del attrs[k]

for k in ['_fbx_rotation', '_fbx_scale', '_fbx_translation', '_pCaptFrame', '_pCaptAlpha']:
    if k in attrs:
        del attrs[k]

new_json_bytes = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
pad_len = (4 - (len(new_json_bytes) % 4)) % 4
new_json_bytes += b' ' * pad_len

bin_pad_len = (4 - (len(bin_data) % 4)) % 4
bin_data += b'\x00' * bin_pad_len

total_glb_len = 12 + 8 + len(new_json_bytes) + 8 + len(bin_data)

header = struct.pack('<4sII', b'glTF', 2, total_glb_len)
json_chunk_hdr = struct.pack('<I4s', len(new_json_bytes), b'JSON')
bin_chunk_hdr = struct.pack('<I4s', len(bin_data), b'BIN\x00')

out_path = 'assets/glb/monster.glb'
with open(out_path, 'wb') as f:
    f.write(header)
    f.write(json_chunk_hdr)
    f.write(new_json_bytes)
    f.write(bin_chunk_hdr)
    f.write(bin_data)

print(f'Pristine GLB generated: {out_path}')
