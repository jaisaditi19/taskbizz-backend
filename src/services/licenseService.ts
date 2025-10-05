import {
  PrismaClient as OrgPrisma,
  LicenseStatus,
  ReminderStatus,
} from "../../prisma/generated/org-client";
import {
  bootstrapLicenseComputedFields,
  normalizeOffsets,
  buildReminderRunAt,
} from "./licenseScheduler";

/** -------- CREATE -------- */
type CreateParams = {
  orgPrisma: OrgPrisma;
  orgId: string;
  actorId: string;
  body: {
    title: string;
    licenseNumber?: string | null;
    type?: string | null;
    holder: "ORG" | "CLIENT";
    clientId?: string | null;
    projectId?: string | null;
    serviceId?: string | null;
    vendorId?: string | null;

    issuedOn?: string | null;
    validFrom?: string | null;
    expiresOn: string;

    remindOffsets?: number[];
    gracePeriodDays?: number;
    muted?: boolean;

    responsibleId: string;
    assigneeIds?: string[];
  };
  orgReminderHour?: number; // optional per-org config
  orgReminderMinute?: number;
};

export async function createLicenseWithReminders(params: CreateParams) {
  const {
    orgPrisma,
    orgId,
    actorId,
    body,
    orgReminderHour = 10,
    orgReminderMinute = 0,
  } = params;

  const exp = new Date(body.expiresOn);
  const computed = bootstrapLicenseComputedFields({
    expiresOn: exp,
    remindOffsets: body.remindOffsets,
    gracePeriodDays: body.gracePeriodDays,
  });

  const offsets = normalizeOffsets(
    computed.remindOffsets?.length ? computed.remindOffsets : [-7, -1]
  );

  return await orgPrisma.$transaction(async (tx) => {
    const license = await tx.license.create({
      data: {
        title: body.title,
        licenseNumber: body.licenseNumber ?? null,
        type: body.type ?? null,
        holder: body.holder,
        clientId: body.clientId ?? null,
        projectId: body.projectId ?? null,
        serviceId: body.serviceId ?? null,
        vendorId: body.vendorId ?? null,
        issuedOn: body.issuedOn ? new Date(body.issuedOn) : null,
        validFrom: body.validFrom ? new Date(body.validFrom) : null,
        expiresOn: exp,
        remindOffsets: offsets,
        gracePeriodDays: body.gracePeriodDays ?? 15,
        muted: body.muted ?? false,
        responsibleId: body.responsibleId,
        status: computed.status,
        nextReminderAt: null, // not used when materializing ScheduledReminder
        createdById: actorId,
      },
    });

    // Assignees (WATCHERS)
    const uniqueWatchers = Array.from(new Set(body.assigneeIds ?? [])).filter(
      (id) => id !== body.responsibleId
    );
    if (uniqueWatchers.length) {
      await tx.licenseAssignee.createMany({
        data: uniqueWatchers.map((uid) => ({
          licenseId: license.id,
          userId: uid,
        })),
      });
    }

    // History
    await tx.licenseHistory.create({
      data: {
        licenseId: license.id,
        action: "CREATED",
        payload: { body },
        actorId,
      },
    });

    // Materialize ScheduledReminder rows
    if (!license.muted && offsets.length) {
      for (const off of offsets) {
        const runAt = buildReminderRunAt(
          license.expiresOn,
          off,
          orgReminderHour,
          orgReminderMinute
        );
        if (runAt.getTime() < Date.now()) continue; // skip past reminders
        await tx.scheduledReminder.upsert({
          where: {
            licenseId_offsetDays: { licenseId: license.id, offsetDays: off },
          },
          update: { runAt, status: ReminderStatus.PENDING },
          create: {
            licenseId: license.id,
            runAt,
            offsetDays: off,
            orgLocalDay: new Date(license.expiresOn), // for reporting
            status: ReminderStatus.PENDING,
          },
        });
      }
    }

    return license;
  });
}

/** -------- UPDATE -------- */
type UpdateParams = {
  orgPrisma: OrgPrisma;
  orgId: string;
  actorId: string;
  id: string;
  body: Partial<CreateParams["body"]>;
  orgReminderHour?: number;
  orgReminderMinute?: number;
};

export async function updateLicenseAndReminders(params: UpdateParams) {
  const {
    orgPrisma,
    orgId,
    actorId,
    id,
    body,
    orgReminderHour = 10,
    orgReminderMinute = 0,
  } = params;

  return await orgPrisma.$transaction(async (tx) => {
    const prev = await tx.license.findUnique({ where: { id } });
    if (!prev) throw new Error("License not found");

    const nextExpiresOn = body.expiresOn
      ? new Date(body.expiresOn)
      : prev.expiresOn;
    const nextOffsets = normalizeOffsets(
      body.remindOffsets ?? prev.remindOffsets ?? [-7, -1]
    );
    const nextMuted = body.muted ?? prev.muted;

    // Update license
    const updated = await tx.license.update({
      where: { id },
      data: {
        title: body.title ?? prev.title,
        licenseNumber: body.licenseNumber ?? prev.licenseNumber,
        type: body.type ?? prev.type,
        holder: (body.holder as any) ?? prev.holder,
        clientId: body.clientId ?? prev.clientId,
        projectId: body.projectId ?? prev.projectId,
        serviceId: body.serviceId ?? prev.serviceId,
        vendorId: body.vendorId ?? prev.vendorId,
        issuedOn: body.issuedOn ? new Date(body.issuedOn) : prev.issuedOn,
        validFrom: body.validFrom ? new Date(body.validFrom) : prev.validFrom,
        expiresOn: nextExpiresOn,
        remindOffsets: nextOffsets,
        gracePeriodDays: body.gracePeriodDays ?? prev.gracePeriodDays,
        muted: nextMuted,
        responsibleId: body.responsibleId ?? prev.responsibleId,
      },
    });

    // Replace watchers if provided
    if (body.assigneeIds) {
      await tx.licenseAssignee.deleteMany({ where: { licenseId: id } });
      const watchers = Array.from(new Set(body.assigneeIds)).filter(
        (uid) => uid !== updated.responsibleId
      );
      if (watchers.length) {
        await tx.licenseAssignee.createMany({
          data: watchers.map((uid) => ({ licenseId: id, userId: uid })),
        });
      }
    }

    // History
    await tx.licenseHistory.create({
      data: {
        licenseId: id,
        action: "UPDATED",
        payload: body,
        actorId,
      },
    });

    // Rebuild reminders (cancel-all pending -> recreate)
    await tx.scheduledReminder.updateMany({
      where: { licenseId: id, status: ReminderStatus.PENDING },
      data: { status: ReminderStatus.CANCELLED },
    });

    if (!nextMuted && nextOffsets.length) {
      for (const off of nextOffsets) {
        const runAt = buildReminderRunAt(
          nextExpiresOn,
          off,
          orgReminderHour,
          orgReminderMinute
        );
        if (runAt.getTime() < Date.now()) continue;
        await tx.scheduledReminder.upsert({
          where: { licenseId_offsetDays: { licenseId: id, offsetDays: off } },
          update: { runAt, status: ReminderStatus.PENDING },
          create: {
            licenseId: id,
            runAt,
            offsetDays: off,
            orgLocalDay: new Date(nextExpiresOn),
            status: ReminderStatus.PENDING,
          },
        });
      }
    }

    return updated;
  });
}

/** -------- RENEW -------- */
type RenewParams = {
  orgPrisma: OrgPrisma;
  orgId: string;
  actorId: string;
  id: string;
  newExpiresOn: string;
  newValidFrom?: string | null;
  newLicenseNumber?: string | null;
  remindOffsets?: number[];
  gracePeriodDays?: number;
  orgReminderHour?: number;
  orgReminderMinute?: number;
};

export async function renewLicense({
  orgPrisma,
  orgId,
  actorId,
  id,
  newExpiresOn,
  newValidFrom,
  newLicenseNumber,
  remindOffsets,
  gracePeriodDays,
  orgReminderHour = 10,
  orgReminderMinute = 0,
}: RenewParams) {
  return await orgPrisma.$transaction(async (tx) => {
    const lic = await tx.license.findUnique({ where: { id } });
    if (!lic) throw new Error("License not found");

    const exp = new Date(newExpiresOn);
    const offsets = normalizeOffsets(
      remindOffsets ?? lic.remindOffsets ?? [-7, -1]
    );

    const updated = await tx.license.update({
      where: { id },
      data: {
        expiresOn: exp,
        validFrom: newValidFrom ? new Date(newValidFrom) : lic.validFrom,
        licenseNumber: newLicenseNumber ?? lic.licenseNumber,
        remindOffsets: offsets,
        gracePeriodDays: gracePeriodDays ?? lic.gracePeriodDays,
        status: LicenseStatus.ACTIVE, // reset; nightly job can flip later
      },
    });

    await tx.licenseHistory.create({
      data: {
        licenseId: id,
        action: "RENEWED",
        payload: { newExpiresOn, newValidFrom, newLicenseNumber },
        actorId,
      },
    });

    // Rebuild reminders
    await tx.scheduledReminder.updateMany({
      where: { licenseId: id, status: ReminderStatus.PENDING },
      data: { status: ReminderStatus.CANCELLED },
    });

    if (!updated.muted && offsets.length) {
      for (const off of offsets) {
        const runAt = buildReminderRunAt(
          exp,
          off,
          orgReminderHour,
          orgReminderMinute
        );
        if (runAt.getTime() < Date.now()) continue;
        await tx.scheduledReminder.upsert({
          where: { licenseId_offsetDays: { licenseId: id, offsetDays: off } },
          update: { runAt, status: ReminderStatus.PENDING },
          create: {
            licenseId: id,
            runAt,
            offsetDays: off,
            orgLocalDay: new Date(exp),
            status: ReminderStatus.PENDING,
          },
        });
      }
    }

    return updated;
  });
}
