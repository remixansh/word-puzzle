const PROD_SERVER = "https://word-puzzle-iaz0.onrender.com"; 
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
        // Only rejoin if we have a saved ID (meaning game had already started)
        document.getElementById('roomInput').value = savedRoom;
        document.getElementById('status').innerText = "Rejoining previous game...";
        setTimeout(() => {
             // Re-verify the room ID hasn't been cleared by a fresh action
             if(localStorage.getItem('wordgame_roomid') === savedRoom) {
                 joinRoom(true); // true = isRejoin
             }
        }, 500); 
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
    // 1. Show the Room ID
    document.getElementById('status').innerText = `Room Created: ${data.roomId}`;
    
    // 2. Add the Waiting Message
    const waitingMsg = document.createElement('div');
    waitingMsg.innerHTML = `<br><b>Waiting for opponent to join...</b> ⏳`;
    waitingMsg.style.color = "#f39c12"; 
    document.getElementById('status').appendChild(waitingMsg);
    
    currentRoom = data.roomId;
    const card = document.querySelector('.card');
    if(card) card.style.display = 'none';
});

socket.on('error', (msg) => {
    alert("Error: " + msg);
    if(msg.includes('not found') || msg.includes('full')) {
        localStorage.removeItem('wordgame_roomid');
        location.reload(); 
    }
});

socket.on('game_start', (data) => {
    // Hide lobby, Show Game
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    
    currentRoom = currentRoom || localStorage.getItem('wordgame_roomid');
    
    if(currentRoom) {
        localStorage.setItem('wordgame_roomid', currentRoom);
    }

    document.getElementById('room-display').innerText = `${currentRoom}`;
    
    const themeName = data.theme || 'Random';
    const icon = getThemeIcon(themeName);
    const displayName = themeName.charAt(0).toUpperCase() + themeName.slice(1);
    document.getElementById('theme-display').innerText = `${displayName} ${icon}`;
    
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

// NEW: Handle player leaving
socket.on('player_left', (data) => {
    alert(data.msg);
    localStorage.removeItem('wordgame_roomid');
    location.reload(); // Reload to go back to lobby
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
    const finalScoreMsg = document.getElementById('final-score-msg');
    
    localStorage.removeItem('wordgame_roomid');

    if(data.winner === myUserId) {
        msg.innerText = "VICTORY! 🏆";
        msg.style.color = "#00b894";
        if(finalScoreMsg) finalScoreMsg.innerText = "You conquered the grid!";
    } else if (data.winner === 'draw') {
        msg.innerText = "DRAW! 🤝";
        msg.style.color = "#74b9ff";
        if(finalScoreMsg) finalScoreMsg.innerText = "A perfectly matched battle.";
    } else {
        msg.innerText = "DEFEAT 💀";
        msg.style.color = "#ff7675";
        if(finalScoreMsg) finalScoreMsg.innerText = "Better luck next time.";
    }
    modal.style.display = 'flex';
});

// --- ACTIONS ---

function createRoom() {
    document.getElementById('status').innerText = "Creating Room...";
    localStorage.removeItem('wordgame_roomid');
    const selectedRound = document.querySelector('input[name="rounds"]:checked');
    const rounds = selectedRound ? selectedRound.value : 5;
    socket.emit('create_room', { userId: myUserId, rounds: rounds });
}

function joinRoom(isRejoin = false) {
    let id = isRejoin ? localStorage.getItem('wordgame_roomid') : document.getElementById('roomInput').value.trim();
    
    if(id) {
        if(!isRejoin) {
             localStorage.removeItem('wordgame_roomid');
        }
        
        document.getElementById('status').innerText = "Joining...";
        socket.emit('join_room', { roomId: id, userId: myUserId });
        currentRoom = id;
        
    }
}

function exitGame() {
    if(confirm("Exit game? This will end the match for everyone.")) {
        socket.emit('leave_game', { roomId: currentRoom });
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
            // Add mouseover for drag selection
            cell.onmouseover = (e) => {
                if(e.buttons === 1) handleSelect(cell);
            }
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

    // EASTER EGG: Check if all 100 cells are selected (Grid is 10x10)
    if (selectedPath.length >= 100) {
        const easterEgg = document.getElementById('easter-egg');
        easterEgg.style.display = 'flex';
        setTimeout(() => {
            easterEgg.style.display = 'none';
            // Clear selection too
            selectedPath.forEach(c => c.classList.remove('selected'));
            selectedPath = [];
        }, 4000);
        return;
    }

    checkWord();
}

function checkWord() {
    const word = selectedPath.map(c => c.dataset.char).join('');
    if(word.length > 1) {
        socket.emit('word_found', { roomId: currentRoom, word: word, userId: myUserId });
    }
}