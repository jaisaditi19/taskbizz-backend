"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_cron_1 = __importDefault(require("node-cron"));
const coreClient_1 = require("../prisma/coreClient");
// Runs every hour at minute 0 (e.g., 1:00, 2:00, 3:00 ...)
node_cron_1.default.schedule('0 * * * *', async () => {
    try {
        const deleted = await coreClient_1.prisma.refreshToken.deleteMany({
            where: {
                OR: [
                    { expiresAt: { lt: new Date() } }, // expired tokens
                    { revoked: true } // revoked tokens
                ]
            }
        });
        if (deleted.count > 0) {
            console.log(`Deleted ${deleted.count} expired or revoked refresh tokens.`);
        }
        else {
            console.log('No expired or revoked refresh tokens to delete at this time.');
        }
    }
    catch (error) {
        console.error('Error cleaning up refresh tokens:', error);
    }
});
