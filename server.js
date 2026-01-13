const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 托管 public 文件夹
app.use(express.static(path.join(__dirname, 'public')));

// 简单的麻将数据：万条筒 (简化版：仅 1-9万)
function createDeck() {
    let deck = [];
    for (let i = 1; i <= 9; i++) {
        for (let j = 0; j < 4; j++) {
            deck.push(`${i}万`);
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

const rooms = {};

io.on('connection', (socket) => {
    console.log('玩家连接: ' + socket.id);

    socket.on('joinRoom', (roomId) => {
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

        // 避免重复加入
        const existingPlayer = room.players.find(p => p.id === socket.id);
        if (!existingPlayer && room.players.length < 4) {
            room.players.push({ id: socket.id, hand: [] });
        }

        io.to(roomId).emit('updateInfo', `房间人数: ${room.players.length}/4`);

        // 满4人自动开始
        if (room.players.length === 4 && !room.gameStarted) {
            startGame(roomId);
        }
    });

    socket.on('playCard', ({ roomId, card, index }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        // 简单逻辑：打一张，摸一张，换下一个人
        // (注：这里省略了复杂的碰杠胡判断，仅做联机演示)
        const player = room.players.find(p => p.id === socket.id);
        if(!player) return;

        player.hand.splice(index, 1); // 移除手牌
        io.to(roomId).emit('msg', `有人打出了 【${card}】`);

        // 轮转
        room.turnIndex = (room.turnIndex + 1) % 4;
        
        // 下家摸牌
        const nextPlayer = room.players[room.turnIndex];
        if (room.deck.length > 0) {
            nextPlayer.hand.push(room.deck.pop());
            nextPlayer.hand.sort();
        }

        syncState(roomId);
    });
});

function startGame(roomId) {
    const room = rooms[roomId];
    room.gameStarted = true;
    io.to(roomId).emit('msg', '游戏开始！');
    
    // 发牌
    room.players.forEach(p => {
        p.hand = [];
        for(let i=0; i<13; i++) p.hand.push(room.deck.pop());
        p.hand.sort();
    });
    // 庄家多摸一张
    room.players[0].hand.push(room.deck.pop());

    syncState(roomId);
}

function syncState(roomId) {
    const room = rooms[roomId];
    room.players.forEach((p, idx) => {
        io.to(p.id).emit('gameState', {
            hand: p.hand,
            isMyTurn: idx === room.turnIndex
        });
    });
}

// 端口监听 (Replit 会自动分配端口)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('Server is running');
});