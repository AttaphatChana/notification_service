// src/index.ts
import dotenv from "dotenv";
dotenv.config();

// Map to track userId to socketId
const userSockets = new Map<string, string>();

import http from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { Kafka } from "kafkajs";

async function bootstrap() {
    // —– 1) HTTP + Socket.IO setup
    const httpServer = http.createServer();
    const io = new Server(httpServer, { /* your CORS / options */ });

    // —– 2) Redis adapter for scaling
    const pubClient = createClient({ url: process.env.REDIS_URL });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));

    // —– 3) Kafka producer for offline enqueues
    const kafka = new Kafka({ brokers: (process.env.KAFKA_BROKERS || "").split(",") });
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
        topics: [{ topic: 'offline_messages', numPartitions: 1, replicationFactor: 1 }],
    });
    await admin.disconnect();
    const producer = kafka.producer();
    await producer.connect();

    io.on("connection", async (socket) => {
        const userId = socket.handshake.auth.userId as string;
        userSockets.set(userId, socket.id);
        // —– 4) On connect: spin up a Kafka consumer for this user
        const consumer = kafka.consumer({ groupId: `offline_${userId}` }); // read by the offset
        await consumer.connect();

        // Subscribe to a shared topic, partitioned by userId
        await consumer.subscribe({ topic: "offline_messages", fromBeginning: true });
        console.log(`STARTED: Kafka consumer for user ${userId} connected`);

        // Drain any pending messages for this user
        await consumer.run({
            eachMessage: async ({ message }) => {
                console.log(`Kafka consumer received key=${message.key?.toString()}, userId=${userId}`);
                if (message.key?.toString() === userId) {
                    const { event, data } = JSON.parse(message.value!.toString());
                    socket.emit(event, data);
                    console.log(`Delivered offline message to ${userId}`);
                }
            },
        });
        console.log(`consumer.run() for user ${userId}`);

        socket.on("disconnect", async () => {
            userSockets.delete(userId);
            await consumer.disconnect();
        });
        socket.on("test", async (msg) => {
            console.log(`Received test message from ${userId}:`, msg);
        });

        // —– 5) online/ offline messages

        socket.on("private_message", async ({ toUserId, content }) => {
            console.log(`-------Private message from ${toUserId} --------`);
            const targetSocketId = userSockets.get(toUserId);
            const target = targetSocketId ? io.sockets.sockets.get(targetSocketId) : undefined;
            if (target?.connected) {
                // online → direct
                target.emit("private_message", content);
                console.log(`User ${toUserId} is online, message sent directly.`);
            } else {
                // offline → enqueue into Kafka
                await producer.send({
                    topic: "offline_messages",
                    messages: [
                        {
                            key: toUserId,
                            value: JSON.stringify({ event: "private_message", data: content }),
                        },
                    ],
                });
                console.log(`User ${toUserId} is offline, message enqueued.`);
            }
        });
    });

    httpServer.listen(3000, () => console.log("⚡️ on port 3000"));
}

bootstrap();
