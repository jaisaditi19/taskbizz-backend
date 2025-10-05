import cron from 'node-cron';
import { prisma } from '../prisma/coreClient';

// Runs every hour at minute 0 (e.g., 1:00, 2:00, 3:00 ...)
cron.schedule('0 * * * *', async () => {
  try {
    const deleted = await prisma.refreshToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },  // expired tokens
          { revoked: true }                    // revoked tokens
        ]
      }
    });

    if (deleted.count > 0) {
      console.log(`Deleted ${deleted.count} expired or revoked refresh tokens.`);
    } else {
      console.log('No expired or revoked refresh tokens to delete at this time.');
    }
  } catch (error) {
    console.error('Error cleaning up refresh tokens:', error);
  }
});
