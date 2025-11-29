const PROD_SERVER = ""; 

const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const socket = io(isLocal ? 'http://localhost:5000' : PROD_SERVER);

let currentRoom = null;
let selectedPath = [];
let selectionTimer = null; 

// --- PERSISTENCE ---
function getUserId() {
    let id = localStorage.getItem('wordgame_userid');
    if (!id) {
        id = 'user_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('wordgame_userid', id);
    }
    return id;
}

const myUserId = getUserId(); 

window.onload = () => {
    const savedRoom = localStorage.getItem('wordgame_roomid');
    if (savedRoom) {
        document.getElementById('roomInput').value = savedRoom;
        document.getElementById('status').innerText = "Rejoining previous game...";
        setTimeout(() => joinRoom(), 500); 
    }
};

// --- HELPER: THEME ICONS ---
function getThemeIcon(theme) {
    if (!theme) return '🎲';
    const icons = {
        'animals': '🦁', 'space': '🚀', 'tech': '💻', 'food': '🍔',
        'sports': '⚽', 'music': '🎸', 'movies': '🎬', 'travel': '✈️',
        'school': '📚', 'nature': '🌲', 'colors': '🎨', 'countries': '🌍',
        'jobs': '💼', 'weather': '☀️', 'house': '🏠', 'clothes': '👕',
        'body': '👀', 'fruit': '🍎', 'pirate': '🏴‍☠️', 'cars': '🚗'
    };
    return icons[theme.toLowerCase()] || '📦';
}

// --- SOCKET LISTENERS ---

socket.on('room_created', (data) => {
    document.getElementById('status').innerText = `Room ID: ${data.roomId}`;
    currentRoom = data.roomId;
    localStorage.setItem('wordgame_roomid', currentRoom);
});

socket.on('error', (msg) => {
    alert("Error: " + msg);
    if(msg.includes('not found')) {
        localStorage.removeItem('wordgame_roomid');
        location.reload(); 
    }
});

socket.on('game_start', (data) => {
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    
    currentRoom = localStorage.getItem('wordgame_roomid') || currentRoom;
    document.getElementById('room-display').innerText = `Room: ${currentRoom}`;
    const themeName = data.theme || 'Random';
    const icon = getThemeIcon(themeName);
    document.getElementById('theme-display').innerText = `Theme: ${themeName} ${icon}`;
    
    const currentR = data.current_round || 1;
    const totalR = data.total_rounds || 5;
    document.getElementById('round-display').innerText = `Round ${currentR}/${totalR}`;
    
    renderBoard(data.grid);
    renderList(data.words);
    
    if(data.found_history) {
        data.found_history.forEach(item => {
            markFoundWord(item.word, item.finder, item.indices);
        });
    }

    updateScoreboard(data.scores);
});

socket.on('update_board', (data) => {
    markFoundWord(data.word, data.finder, data.indices);
    updateScoreboard(data.scores);
});

function markFoundWord(word, finderId, indices) {
    const wElem = document.getElementById(`word-${word}`);
    if(wElem) wElem.classList.add('crossed');

    const isMe = (finderId === myUserId);
    const className = isMe ? 'found-me' : 'found-enemy';

    if(indices) {
        indices.forEach(pos => {
            const cell = document.getElementById(`cell-${pos.r}-${pos.c}`);
            if(cell) {
                cell.classList.remove('selected');
                cell.classList.add(className);
            }
        });
    }
    
    if(isMe) {
        selectedPath = [];
        if(selectionTimer) clearTimeout(selectionTimer);
    }
}

socket.on('game_over', (data) => {
    const modal = document.getElementById('game-over');
    const msg = document.getElementById('winner-msg');
    
    localStorage.removeItem('wordgame_roomid');

    if(data.winner === myUserId) {
        msg.innerText = "🏆 YOU WIN! 🏆";
        msg.style.color = "green";
    } else if (data.winner === 'draw') {
        msg.innerText = "🤝 DRAW!";
        msg.style.color = "blue";
    } else {
        msg.innerText = "☠️ YOU LOSE! ☠️";
        msg.style.color = "red";
    }
    modal.style.display = 'block';
});

// --- ACTIONS ---

function createRoom() {
    document.getElementById('status').innerText = "Creating Room...";
    const rounds = document.getElementById('roundSelect').value;
    socket.emit('create_room', { userId: myUserId, rounds: rounds });
}

function joinRoom() {
    const id = document.getElementById('roomInput').value.trim();
    if(id) {
        document.getElementById('status').innerText = "Joining...";
        socket.emit('join_room', { roomId: id, userId: myUserId });
        currentRoom = id;
        localStorage.setItem('wordgame_roomid', id);
    }
}

// --- RENDERERS ---

function renderBoard(grid) {
    const container = document.getElementById('grid-container');
    container.innerHTML = '';
    selectedPath = [];

    grid.forEach((row, r) => {
        row.forEach((char, c) => {
            const cell = document.createElement('div');
            cell.classList.add('cell');
            cell.id = `cell-${r}-${c}`;
            cell.innerText = char;
            cell.dataset.char = char;
            cell.onmousedown = () => handleSelect(cell);
            cell.ontouchstart = (e) => { e.preventDefault(); handleSelect(cell); };
            container.appendChild(cell);
        });
    });
}

function renderList(words) {
    const list = document.getElementById('word-list');
    list.innerHTML = words.map(w => `<span id="word-${w}" class="word-item">${w}</span>`).join('');
}

function updateScoreboard(scores) {
    if(!scores) return;
    const myScore = scores[myUserId] || 0;
    let enemyScore = 0;
    Object.keys(scores).forEach(uid => {
        if(uid !== myUserId) enemyScore = scores[uid];
    });
    document.getElementById('my-score').innerText = myScore;
    document.getElementById('enemy-score').innerText = enemyScore;
}

function handleSelect(cell) {
    if(cell.classList.contains('found-me') || cell.classList.contains('found-enemy')) return;

    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
        selectedPath.forEach(c => c.classList.remove('selected'));
        selectedPath = [];
    }, 4000);

    if(cell.classList.contains('selected')) {
        cell.classList.remove('selected');
        selectedPath = selectedPath.filter(c => c !== cell);
    } else {
        cell.classList.add('selected');
        selectedPath.push(cell);
    }
    checkWord();
}

function checkWord() {
    const word = selectedPath.map(c => c.dataset.char).join('');
    if(word.length > 1) {
        socket.emit('word_found', { roomId: currentRoom, word: word, userId: myUserId });
    }
}