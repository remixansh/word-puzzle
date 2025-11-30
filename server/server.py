import eventlet
import socketio
import random
import json
import os
import firebase_admin
from firebase_admin import credentials, firestore

# 1. SETUP FIREBASE
if not firebase_admin._apps:
    local_key = "serviceAccountKey.json"
    cloud_key = "/etc/secrets/serviceAccountKey.json"
    cred_path = local_key if os.path.exists(local_key) else cloud_key
    
    try:
        cred = credentials.Certificate(cred_path)
        firebase_admin.initialize_app(cred)
        print(f"Firebase initialized using {cred_path}")
    except Exception as e:
        print(f"Firebase Init Error: {e}")

db = firestore.client()

sio = socketio.Server(cors_allowed_origins='*')
app = socketio.WSGIApp(sio)

# In-memory cache
rooms = {}

# --- HELPER: SAVE TO FIREBASE ---
def save_room_state(room_id):
    try:
        if room_id in rooms:
            room_data = rooms[room_id].copy()
            if 'grid' in room_data: room_data['grid'] = json.dumps(room_data['grid'])
            db.collection('active_rooms').document(room_id).set(room_data)
    except Exception as e: print(f"Save Error: {e}")

# --- HELPER: LOAD FROM FIREBASE ---
def load_room_state(room_id):
    try:
        doc = db.collection('active_rooms').document(room_id).get()
        if doc.exists:
            data = doc.to_dict()
            if 'grid' in data and isinstance(data['grid'], str): data['grid'] = json.loads(data['grid'])
            rooms[room_id] = data
            return True
    except: pass
    return False

# --- GRID GENERATION ---
def create_grid(words, size=10):
    grid = [['' for _ in range(size)] for _ in range(size)]
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    placements = {} 
    for word in words:
        placed = False; attempts = 0
        while not placed and attempts < 100:
            attempts += 1; direction = random.choice(['H', 'V']); r = random.randint(0, size-1); c = random.randint(0, size-1)
            if direction == 'H':
                if c + len(word) > size: continue
                if all(grid[r][c+i] == '' or grid[r][c+i] == word[i] for i in range(len(word))):
                    indices = []
                    for i, char in enumerate(word): grid[r][c+i] = char; indices.append({'r': r, 'c': c+i})
                    placements[word] = indices; placed = True      
            elif direction == 'V':
                if r + len(word) > size: continue
                if all(grid[r+i][c] == '' or grid[r+i][c] == word[i] for i in range(len(word))):
                    indices = []
                    for i, char in enumerate(word): grid[r+i][c] = char; indices.append({'r': r+i, 'c': c})
                    placements[word] = indices; placed = True
    for r in range(size):
        for c in range(size):
            if grid[r][c] == '': grid[r][c] = random.choice(alphabet)
    return grid, placements

# --- NEW ROUND GENERATOR ---
def generate_new_round():
    try:
        docs = list(db.collection('word_packs').stream())
        if docs:
            category = random.choice(docs).id
            words_list = [w.upper() for w in db.collection('word_packs').document(category).get().to_dict().get('words', [])]
        else:
            category = "Default"; words_list = ["PYTHON", "CODE"]
    except: category = "Error"; words_list = ["ERROR"]
    grid, placements = create_grid(words_list)
    return {'grid': grid, 'words': words_list, 'placements': placements, 'theme': category, 'found_history': [], 'found_words': []}

# --- SOCKET EVENTS ---
@sio.event
def create_room(sid, data):
    room_id = str(random.randint(1000, 9999))
    user_id = data.get('userId', f"anon_{sid}")
    total_rounds = int(data.get('rounds', 5))
    sio.enter_room(sid, room_id)
    
    round_data = generate_new_round()
    
    rooms[room_id] = {
        'roomId': room_id, 
        'current_round': 1, 
        'total_rounds': total_rounds, 
        'scores': {user_id: 0}, 
        'players': {user_id: sid}, 
        'creator_sid': sid, # Track creator to handle disconnect
        'status': 'waiting',
        **round_data
    }
    
    save_room_state(room_id)
    sio.emit('room_created', {'roomId': room_id, 'theme': round_data['theme']}, room=sid)

@sio.event
def join_room(sid, data):
    room_id = str(data.get('roomId')).strip()
    user_id = data.get('userId', f"anon_{sid}")
    
    if room_id not in rooms:
        if not load_room_state(room_id):
            sio.emit('error', 'Room not found!', room=sid); return

    room = rooms[room_id]
    
    if len(room['players']) >= 2 and user_id not in room['players']:
         sio.emit('error', 'Room is full!', room=sid); return

    sio.enter_room(sid, room_id)
    room['players'][user_id] = sid
    
    if user_id not in room['scores']: room['scores'][user_id] = 0
    
    room['status'] = 'playing'
    save_room_state(room_id)
    
    game_data = {
        'grid': room['grid'], 'words': room['words'], 
        'scores': room['scores'], 'theme': room['theme'], 
        'found_history': room['found_history'], 
        'current_round': room.get('current_round', 1), 
        'total_rounds': room.get('total_rounds', 5)
    }
    sio.emit('game_start', game_data, room=room_id)

@sio.event
def leave_game(sid, data):
    room_id = str(data.get('roomId')).strip()
    cleanup_room(room_id)

@sio.event
def disconnect(sid):
    rooms_to_delete = []
    
    for room_id, room in rooms.items():
        # Case 1: Creator disconnects while waiting (Refresh logic)
        if room.get('status') == 'waiting' and room.get('creator_sid') == sid:
            print(f"Creator {sid} disconnected from waiting room {room_id}. Deleting room.")
            rooms_to_delete.append(room_id)
        
        # Case 2: Any player disconnects during active game
        elif room.get('status') == 'playing' and sid in room['players'].values():
            print(f"Player {sid} disconnected from active room {room_id}.")
            sio.emit('player_left', {'msg': 'Opponent disconnected. Room closed.'}, room=room_id)
            rooms_to_delete.append(room_id)

    for r_id in rooms_to_delete:
        cleanup_room(r_id)

def cleanup_room(room_id):
    if room_id in rooms:
        print(f"Cleaning up Room {room_id}")
        # Notify clients just in case (e.g. valid leave_game call)
        sio.emit('player_left', {'msg': 'Room closed.'}, room=room_id)
        
        try:
            db.collection('active_rooms').document(room_id).delete()
        except Exception as e:
            print(f"Error deleting from DB: {e}")
        
        del rooms[room_id]

@sio.event
def word_found(sid, data):
    room_id = str(data['roomId']); word = data['word']; user_id = data.get('userId', f"anon_{sid}")
    if room_id not in rooms: return
    room = rooms[room_id]
    if word in room['words'] and word not in room['found_words']:
        room['found_words'].append(word); room['scores'][user_id] = room['scores'].get(user_id, 0) + 1
        room['found_history'].append({'word': word, 'finder': user_id, 'indices': room['placements'][word]})
        save_room_state(room_id)
        sio.emit('update_board', {'word': word, 'finder': user_id, 'indices': room['placements'][word], 'scores': room['scores']}, room=room_id)
        if len(room['found_words']) == len(room['words']):
            if room.get('current_round', 1) < room.get('total_rounds', 5):
                room['current_round'] += 1
                room.update(generate_new_round())
                save_room_state(room_id)
                sio.emit('game_start', {'grid': room['grid'], 'words': room['words'], 'scores': room['scores'], 'theme': room['theme'], 'found_history': [], 'current_round': room['current_round'], 'total_rounds': room['total_rounds']}, room=room_id)
            else:
                winner_id = max(room['scores'], key=room['scores'].get)
                sio.emit('game_over', {'winner': winner_id}, room=room_id)
                cleanup_room(room_id)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print(f"Server starting on port {port}...")
    eventlet.wsgi.server(eventlet.listen(('', port)), app)