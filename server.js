const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// --- 1. 创建牌组 ---
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

    // 洗牌
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function sortHand(hand) {
    return hand.sort();
}

// --- 2. 胡牌算法核心 (核心逻辑) ---
// 判断是否满足：4组(顺子/刻子) + 1对将
function checkHu(hand) {
    if (hand.length !== 14) return false;

    // 统计每张牌的数量
    const map = {};
    hand.forEach(card => map[card] = (map[card] || 0) + 1);

    // 辅助函数：尝试移除顺子和刻子
    function tryComplete(currentMap) {
        // 获取所有的牌
        const cards = Object.keys(currentMap).filter(k => currentMap[k] > 0).sort();
        
        // 如果没有牌了，说明匹配成功，胡了！
        if (cards.length === 0) return true;

        const card = cards[0]; // 拿最小的一张牌
        const count = currentMap[card];

        // 1. 尝试组成刻子 (AAA)
        if (count >= 3) {
            currentMap[card] -= 3;
            if (tryComplete(currentMap)) return true;
            currentMap[card] += 3; // 回溯
        }

        // 2. 尝试组成顺子 (ABC) - 只有万条筒能组顺子，字牌不行
        // 解析牌型，例如 "1万" -> num=1, suit="万"
        const num = parseInt(card); 
        const suit = card.replace(/\d/g, ''); 

        if (!isNaN(num) && num <= 7) { // 只能是 1-7 开头，8和9无法做顺子开头
            const next1 = (num + 1) + suit;
            const next2 = (num + 2) + suit;
            
            if (currentMap[next1] > 0 && currentMap[next2] > 0) {
                currentMap[card]--;
                currentMap[next1]--;
                currentMap[next2]--;
                if (tryComplete(currentMap)) return true;
                // 回溯
                currentMap[card]++;
                currentMap[next1]++;
                currentMap[next2]++;
            }
        }

        return false;
    }

    // 遍历每一张牌，尝试把它当做“将牌”(眼)
    for (let card of Object.keys(map)) {
        if (map[card] >= 2) {
            map[card] -= 2; // 移除将牌
            if (tryComplete(map)) return true; // 看看剩下的12张能不能组成4组
            map[card] += 2; // 放回去，试下一张
        }
    }

    return false;
}


io.on('connection', (socket) => {
    // console.log('连接: ' + socket.id);

    socket.on('joinRoom', ({ roomId, playerName, clientId }) => {
        socket.join(roomId);
        
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                deck: createDeck(),
                discards: [],
                turnIndex: 0,
                gameStarted: false
            };
        }

        const room = rooms[roomId];
        const existingPlayer = room.players.find(p => p.id === socket.id);
        const existingClient = clientId ? room.players.find(p => p.clientId === clientId) : null;

        if (existingClient) {
            existingClient.id = socket.id;
            existingClient.name = playerName || existingClient.name;
        } else if (!existingPlayer && room.players.length < 4) {
            room.players.push({ 
                id: socket.id, 
                name: playerName || `玩家${socket.id.substr(0,4)}`,
                clientId: clientId || socket.id,
                hand: [] 
            });
        }

        const playerNames = room.players.map(p => p.name).join(', ');
        io.to(roomId).emit('updateInfo', `房间人数: ${room.players.length}/4 (玩家: ${playerNames})`);

        if (room.players.length === 4 && !room.gameStarted) {
            startGame(roomId);
        }
    });

    socket.on('playCard', ({ roomId, card, index }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if(!player) return;
        if (!room.gameStarted || room.players[room.turnIndex].id !== socket.id) return;

        // 1. 打牌
        player.hand.splice(index, 1); 
        io.to(roomId).emit('msg', `🀄 ${player.name} 打出了 【${card}】`);
        room.discards.push({ name: player.name, card });

        // 2. 检测是否有人点炮胡牌
        const startIndex = room.turnIndex;
        for (let i = 1; i < room.players.length; i++) {
            const checkIndex = (startIndex + i) % room.players.length;
            const otherPlayer = room.players[checkIndex];
            if (checkHu([...otherPlayer.hand, card])) {
                io.to(roomId).emit('msg', `💥 点炮胡！【${otherPlayer.name}】 胡了 ${player.name} 打出的 【${card}】`);
                io.to(roomId).emit('msg', `胡牌牌型：${[...otherPlayer.hand, card].sort().join(' ')}`);
                room.gameStarted = false;
                syncState(roomId);
                return;
            }
        }

        // 3. 轮转
        room.turnIndex = (room.turnIndex + 1) % 4;
        const nextPlayer = room.players[room.turnIndex];

        // 4. 摸牌
        if (room.deck.length > 0) {
            const newCard = room.deck.pop();
            nextPlayer.hand.push(newCard);
            sortHand(nextPlayer.hand);

            // --- 新增：摸牌后立刻检测是否自摸胡牌 ---
            if (checkHu(nextPlayer.hand)) {
                io.to(roomId).emit('msg', `🎉🎉🎉 恭喜！【${nextPlayer.name}】 自摸胡牌了！！`);
                io.to(roomId).emit('msg', `胡牌牌型：${nextPlayer.hand.join(' ')}`);
                room.gameStarted = false; // 结束游戏
            } else {
                // 没胡，继续游戏
            }

        } else {
            io.to(roomId).emit('msg', '❌ 流局！牌摸完了。');
            room.gameStarted = false;
        }

        syncState(roomId);
    });

    socket.on('requestStart', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (room.gameStarted) {
            io.to(roomId).emit('msg', '⚠️ 游戏正在进行中。');
            return;
        }
        if (room.players.length < 4) {
            io.to(roomId).emit('msg', '⚠️ 需要 4 位玩家才能开始新局。');
            return;
        }
        startGame(roomId);
    });

    socket.on('disconnect', () => {
        Object.keys(rooms).forEach((roomId) => {
            const room = rooms[roomId];
            const beforeCount = room.players.length;
            room.players = room.players.filter(player => player.id !== socket.id);
            if (room.players.length !== beforeCount) {
                const playerNames = room.players.map(p => p.name).join(', ');
                io.to(roomId).emit('updateInfo', `房间人数: ${room.players.length}/4 (玩家: ${playerNames})`);
            }
        });
    });
});

function startGame(roomId) {
    const room = rooms[roomId];
    room.gameStarted = true;
    room.deck = createDeck();
    room.discards = [];
    room.turnIndex = 0;
    io.to(roomId).emit('msg', '🚀 游戏开始！');
    
    // 发牌
    room.players.forEach(p => {
        p.hand = [];
        for(let i=0; i<13; i++) {
            if(room.deck.length > 0) p.hand.push(room.deck.pop());
        }
        sortHand(p.hand);
    });

    // 庄家多摸一张
    if(room.deck.length > 0) {
        room.players[0].hand.push(room.deck.pop());
        sortHand(room.players[0].hand);
        
        // 天胡检测
        if (checkHu(room.players[0].hand)) {
            io.to(roomId).emit('msg', `⚡⚡⚡ 天胡！【${room.players[0].name}】 开局直接胡牌！`);
            room.gameStarted = false;
        }
    }

    syncState(roomId);
}

function syncState(roomId) {
    const room = rooms[roomId];
    const currentPlayerName = room.players[room.turnIndex].name;

    room.players.forEach((p, idx) => {
        io.to(p.id).emit('gameState', {
            hand: p.hand,
            isMyTurn: idx === room.turnIndex && room.gameStarted, // 游戏结束就不能动了
            deckCount: room.deck.length,
            turnName: currentPlayerName,
            discards: room.discards,
            gameStarted: room.gameStarted
        });
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
