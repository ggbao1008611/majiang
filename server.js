const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// 创建 136 张麻将牌 + 洗牌
function createDeck() {
    const deck = [];
    const suits = ['万', '条', '筒'];
    const honors = ['东', '南', '西', '北', '中', '发', '白'];

    suits.forEach(suit => {
        for (let i = 1; i <= 9; i++) {
            for (let j = 0; j < 4; j++) deck.push(`${i}${suit}`);
        }
    });

    honors.forEach(honor => {
        for (let j = 0; j < 4; j++) deck.push(honor);
    });

    // Fisher-Yates 洗牌
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function sortHand(hand) {
    return hand.sort();
}

io.on('connection', (socket) => {
    console.log('连接: ' + socket.id);

    // --- 修改点 1：接收对象 { roomId, playerName } ---
    socket.on('joinRoom', ({ roomId, playerName }) => {
        socket.join(roomId);
        
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                deck: createDeck(),
                turnIndex: 0,
                gameStarted: false
            };
        }

        const room = rooms[roomId];

        // 检查是否已存在
        const existingPlayer = room.players.find(p => p.id === socket.id);
        
        if (!existingPlayer && room.players.length < 4) {
            // --- 修改点 2：把名字存进去 ---
            room.players.push({ 
                id: socket.id, 
                name: playerName || `玩家${socket.id.substr(0,4)}`, // 如果没填名字，用ID代替
                hand: [] 
            });
        }

        // 获取所有人的名字列表
        const playerNames = room.players.map(p => p.name).join(', ');
        
        // 通知所有人
        io.to(roomId).emit('updateInfo', `房间人数: ${room.players.length}/4 (玩家: ${playerNames})`);
        io.to(roomId).emit('msg', `👋 【${playerName}】 加入了房间`);

        if (room.players.length === 4 && !room.gameStarted) {
            startGame(roomId);
        }
    });

    socket.on('playCard', ({ roomId, card, index }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if(!player) return;

        player.hand.splice(index, 1); 
        
        // --- 修改点 3：打牌消息带上名字 ---
        io.to(roomId).emit('msg', `🀄 ${player.name} 打出了 【${card}】`);

        room.turnIndex = (room.turnIndex + 1) % 4;
        
        const nextPlayer = room.players[room.turnIndex];
        if (room.deck.length > 0) {
            const newCard = room.deck.pop();
            nextPlayer.hand.push(newCard);
            sortHand(nextPlayer.hand);
        } else {
            io.to(roomId).emit('msg', '❌ 流局！牌摸完了。');
            room.gameStarted = false;
        }

        syncState(roomId);
    });

    socket.on('disconnect', () => { 
        // 暂不处理复杂逻辑 
    });
});

function startGame(roomId) {
    const room = rooms[roomId];
    room.gameStarted = true;
    io.to(roomId).emit('msg', '🚀 游戏开始！');
    
    room.players.forEach(p => {
        p.hand = [];
        for(let i=0; i<13; i++) {
            if(room.deck.length > 0) p.hand.push(room.deck.pop());
        }
        sortHand(p.hand);
    });

    if(room.deck.length > 0) {
        room.players[0].hand.push(room.deck.pop());
        sortHand(room.players[0].hand);
    }

    syncState(roomId);
}

function syncState(roomId) {
    const room = rooms[roomId];
    // 获取当前轮到谁的名字
    const currentPlayerName = room.players[room.turnIndex].name;

    room.players.forEach((p, idx) => {
        io.to(p.id).emit('gameState', {
            hand: p.hand,
            isMyTurn: idx === room.turnIndex,
            deckCount: room.deck.length,
            turnName: currentPlayerName // --- 修改点 4：告诉前端现在是谁的回合 ---
        });
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});