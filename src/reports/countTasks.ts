// src/reports/countTasks.ts
export async function countTasks(prisma: any, where: any): Promise<number> {
  return prisma.taskOccurrence.count({
    where,
  });
}
