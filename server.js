const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 托管 public 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 存储所有房间的信息
const rooms = {};

/**
 * 创建一副完整的麻将牌 (136张)
 * 包含：万、条、筒 (1-9) + 东南西北中发白
 * 使用 Fisher-Yates 算法进行随机洗牌
 */
function createDeck() {
    const deck = [];
    const suits = ['万', '条', '筒'];
    const honors = ['东', '南', '西', '北', '中', '发', '白'];

    // 1. 生成序数牌 (1-9 万/条/筒)
    suits.forEach(suit => {
        for (let i = 1; i <= 9; i++) {
            for (let j = 0; j < 4; j++) {
                deck.push(`${i}${suit}`);
            }
        }
    });

    // 2. 生成字牌 (东南西北中发白)
    honors.forEach(honor => {
        for (let j = 0; j < 4; j++) {
            deck.push(honor);
        }
    });

    // 3. 专业洗牌算法 (Fisher-Yates Shuffle)
    // 确保牌序完全随机，没有规律
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]]; // 交换位置
    }

    return deck;
}

// 简单的排序辅助函数，让手牌看起来整齐一点
function sortHand(hand) {
    // 这里使用默认字符串排序，虽然 '10万' 会排在 '2万' 前面，
    // 但作为原型足够用了。如果需要完美排序需要写更复杂的逻辑。
    return hand.sort(); 
}

io.on('connection', (socket) => {
    console.log('玩家连接: ' + socket.id);

    // 玩家加入房间逻辑
    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        
        // 如果房间不存在，初始化房间
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                deck: createDeck(),
                turnIndex: 0,
                gameStarted: false
            };
        }

        const room = rooms[roomId];

        // 避免同一个 socket 重复加入
        const existingPlayer = room.players.find(p => p.id === socket.id);
        if (!existingPlayer && room.players.length < 4) {
            room.players.push({ 
                id: socket.id, 
                hand: [] 
            });
        }

        // 通知房间内人数更新
        io.to(roomId).emit('updateInfo', `房间人数: ${room.players.length}/4`);

        // 满4人自动开始游戏
        if (room.players.length === 4 && !room.gameStarted) {
            startGame(roomId);
        }
    });

    // 玩家出牌逻辑
    socket.on('playCard', ({ roomId, card, index }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        // 找到当前操作的玩家
        const player = room.players.find(p => p.id === socket.id);
        if(!player) return;

        // 1. 从手牌移除打出的这张牌
        player.hand.splice(index, 1); 
        io.to(roomId).emit('msg', `玩家打出了 【${card}】`);

        // 2. 轮转到下一个人
        room.turnIndex = (room.turnIndex + 1) % 4;
        
        // 3. 下一个人自动摸牌 (如果牌墙还有牌)
        const nextPlayer = room.players[room.turnIndex];
        if (room.deck.length > 0) {
            const newCard = room.deck.pop();
            nextPlayer.hand.push(newCard);
            sortHand(nextPlayer.hand); // 自动理牌
        } else {
            io.to(roomId).emit('msg', '流局！牌摸完了。');
            room.gameStarted = false; // 游戏结束
        }

        // 4. 同步最新状态给所有人
        syncState(roomId);
    });

    socket.on('disconnect', () => {
        console.log('玩家断开连接');
        // 简单的原型暂不处理复杂的断线重连逻辑
    });
});

// 开始游戏初始化
function startGame(roomId) {
    const room = rooms[roomId];
    room.gameStarted = true;
    io.to(roomId).emit('msg', '游戏开始！正在发牌...');
    
    // 给每个人发13张牌
    room.players.forEach(p => {
        p.hand = [];
        for(let i=0; i<13; i++) {
            if(room.deck.length > 0) {
                p.hand.push(room.deck.pop());
            }
        }
        sortHand(p.hand);
    });

    // 庄家 (第一个人) 多摸一张 (共14张)
    if(room.deck.length > 0) {
        room.players[0].hand.push(room.deck.pop());
        sortHand(room.players[0].hand);
    }

    syncState(roomId);
}

// 同步状态函数：告诉每个人自己的手牌是什么，以及轮到谁了
function syncState(roomId) {
    const room = rooms[roomId];
    room.players.forEach((p, idx) => {
        io.to(p.id).emit('gameState', {
            hand: p.hand,
            isMyTurn: idx === room.turnIndex,
            deckCount: room.deck.length // 告诉前端还剩多少张牌
        });
    });
}

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});