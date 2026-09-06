// Vercel Serverless Function 專用的 MQTT 配對邏輯
import mqtt from 'mqtt';

export default async function handler(req, res) {
    // 只允許 POST 請求
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { userID } = req.body;
    if (!userID) return res.status(400).json({ error: 'Missing userID' });

    // 連接到免費的公共 MQTT Broker (實際產品可換成您自己的加密伺服器)
    const client = mqtt.connect('mqtt://://hivemq.com');

    // 包裝成 Promise 以控制 Vercel 的執行時間，避免超過 10 秒限制
    await new Promise((resolve) => {
        client.on('connect', () => {
            // 1. 將自己加入排隊名單（發布一則保留訊息 Retained Message，時效設在內容裡）
            const playerPayload = JSON.stringify({ userID, time: Date.now() });
            client.publish(`lobby/players/${userID}`, playerPayload, { retain: true });

            // 2. 訂閱目前所有在排隊的主題
            client.subscribe('lobby/players/#');
        });

        let allPlayers = [];

        client.on('message', (topic, message) => {
            try {
                const player = JSON.parse(message.toString());
                // 只收集 10 秒內還有在呼叫 API 的「活耀玩家」，過期的不計入
                if (Date.now() - player.time < 10000) {
                    // 避免重複加入
                    if (!allPlayers.some(p => p.userID === player.userID)) {
                        allPlayers.push(player);
                    }
                }
            } catch (e) {
                // 忽略解析失敗的訊息
            }
        });

        // 關鍵：給系統 1.2 秒的時間收集在線上的玩家名單
        setTimeout(() => {
            // 依排隊時間排序，確保大家看到的順序是一樣的
            allPlayers.sort((a, b) => a.time - b.time);

            // 3. 如果連同自己有 2 個人以上在排隊，就進行隨機兩兩配對
            if (allPlayers.length >= 2) {
                // 取出最前面的兩個人
                const playerA = allPlayers[0].userID;
                const playerB = allPlayers[1].userID;
                
                // 隨機生成一個房間 ID
                const roomId = `room_${Math.random().toString(36).substring(2, 9)}`;

                // 發布配對成功通知到這兩個人的個人專屬主題
                client.publish(`user/${playerA}/match`, JSON.stringify({ status: 'success', roomId, opponent: playerB }));
                client.publish(`user/${playerB}/match`, JSON.stringify({ status: 'success', roomId, opponent: playerA }));

                // 從 MQTT 上清除這兩個人的排隊保留訊息 (發布空訊息 + retain = 刪除)
                client.publish(`lobby/players/${playerA}`, '', { retain: true });
                client.publish(`lobby/players/${playerB}`, '', { retain: true });

                res.status(200).json({ status: 'matched', roomId });
                client.end();
                resolve();
            } else {
                // 人數不夠，請前端 3 秒後再來看一次
                res.status(200).json({ status: 'waiting' });
                client.end();
                resolve();
            }
        }, 1200);
    });
}
