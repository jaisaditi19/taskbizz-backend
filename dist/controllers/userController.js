"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bulkInviteUsers = exports.deleteUser = exports.editUser = exports.getAllUsers = exports.changePassword = exports.inviteUser = exports.updateProfile = exports.getProfile = exports.updateProfileWithLogo = void 0;
const mailerSend_1 = require("../utils/mailerSend");
const bcrypt_1 = __importDefault(require("bcrypt"));
const container_1 = require("../di/container");
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const spaces_1 = require("../config/spaces");
const crypto_1 = require("crypto");
const path_1 = __importDefault(require("path"));
const orgCache_1 = require("../utils/orgCache");
async function resolveSeatContext(req) {
    // Prefer middleware-provided context
    const ctx = req.subscriptionCtx;
    if (ctx) {
        const licensed = ctx.isTrial
            ? (ctx.plan?.features?.limits?.minUsers ?? 1)
            : ctx.seats?.licensed ?? 0;
        const used = ctx.seats?.used ?? 0;
        return { isTrial: !!ctx.isTrial, licensed, used };
    }
    // Fallback: compute from DB (in case middleware isn’t applied on this route)
    const orgId = req.user?.orgId;
    if (!orgId)
        return { isTrial: false, licensed: 0, used: 0 };
    const prisma = (0, container_1.getCorePrisma)();
    const sub = await prisma.subscription.findFirst({
        where: { orgId },
        orderBy: { startDate: "desc" },
        include: { plan: true },
    });
    if (!sub || !sub.plan)
        return { isTrial: false, licensed: 0, used: 0 };
    const minUsers = (sub.plan.features?.limits?.minUsers ??
        1);
    const licensed = sub.isTrial ? minUsers : sub.userCount ?? minUsers;
    const used = await prisma.user.count({
        where: { orgId, status: { not: "SUSPENDED" } },
    });
    return { isTrial: sub.isTrial, licensed, used };
}
const updateProfileWithLogo = async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ message: "Unauthorized" });
        const prisma = (0, container_1.getCorePrisma)();
        // ✅ NEW: Get user role early for validation
        const userRole = req.user.role;
        const isManager = userRole === "MANAGER";
        // Read known profile fields from either JSON body or form-data body
        let { name, phone, address, city, state, pincode, panNumber, orgDisplayName, } = req.body;
        // Basic sanitization
        name = typeof name === "string" ? name.trim() : undefined;
        phone = typeof phone === "string" ? phone.trim() : undefined;
        address = typeof address === "string" ? address.trim() : null;
        city = typeof city === "string" ? city.trim() : null;
        state = typeof state === "string" ? state.trim() : null;
        pincode = typeof pincode === "string" ? pincode.trim() : null;
        panNumber = typeof panNumber === "string" ? panNumber.trim() : null;
        orgDisplayName =
            typeof orgDisplayName === "string" ? orgDisplayName.trim() : undefined;
        // ✅ NEW: Block managers from uploading logo
        if (isManager && req.file) {
            return res.status(403).json({
                message: "FORBIDDEN: Only admins can update the organization logo",
            });
        }
        // ✅ NEW: Block managers from changing org display name
        if (isManager && orgDisplayName !== undefined) {
            return res.status(403).json({
                message: "FORBIDDEN: Only admins can update the organization name",
            });
        }
        // If a file was uploaded, upload it to Spaces and set logoKey
        let logoKey;
        if (req.file) {
            const maxBytes = 2 * 1024 * 1024; // 2MB
            if (req.file.size > maxBytes) {
                return res.status(400).json({ message: "LOGO_TOO_LARGE", maxBytes });
            }
            const ext = path_1.default.extname(req.file.originalname || "") || ".png";
            logoKey = `org_logos/${Date.now()}-${(0, crypto_1.randomUUID)()}${ext}`;
            try {
                await spaces_1.spaces.send(new client_s3_1.PutObjectCommand({
                    Bucket: process.env.SPACES_BUCKET,
                    Key: logoKey,
                    Body: req.file.buffer,
                    ContentType: req.file.mimetype || "image/png",
                }));
            }
            catch (spacesErr) {
                console.error("Spaces upload failed:", spacesErr);
                return res.status(500).json({ message: "SPACES_UPLOAD_FAILED" });
            }
        }
        // Fetch the user's organization id (we'll need it to update org)
        const existingUser = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: {
                id: true,
                orgId: true,
                organization: { select: { id: true } },
            },
        });
        if (!existingUser) {
            return res.status(404).json({ message: "USER_NOT_FOUND" });
        }
        // Run user update + optional org update inside a transaction
        const [updatedUser, orgUpdated] = await prisma.$transaction(async (tx) => {
            const u = await tx.user.update({
                where: { id: req.user.id },
                data: {
                    ...(name !== undefined ? { name } : {}),
                    ...(phone !== undefined ? { phone } : {}),
                    address: address ?? null,
                    city: city ?? null,
                    state: state ?? null,
                    pincode: pincode ?? null,
                    panNumber: panNumber ?? null,
                },
                select: {
                    id: true,
                    name: true,
                    email: true,
                    phone: true,
                    role: true,
                    address: true,
                    city: true,
                    state: true,
                    pincode: true,
                    panNumber: true,
                    organization: {
                        select: { id: true, name: true, dbName: true, logoUrl: true },
                    },
                },
            });
            let orgResult = u.organization;
            // ✅ UPDATED: Only update org if NOT manager AND (logoKey or orgDisplayName present)
            if (!isManager &&
                u.organization?.id &&
                (logoKey || orgDisplayName !== undefined)) {
                const orgData = {};
                if (logoKey)
                    orgData.logoUrl = logoKey;
                if (orgDisplayName !== undefined)
                    orgData.name = orgDisplayName;
                const updatedOrg = await tx.organization.update({
                    where: { id: u.organization.id },
                    data: orgData,
                    select: { id: true, name: true, dbName: true, logoUrl: true },
                });
                orgResult = updatedOrg;
            }
            return [u, orgResult];
        });
        try {
            if (orgUpdated && orgUpdated.id) {
                await (0, container_1.invalidateOrgMeta)(orgUpdated.id);
                await (0, orgCache_1.invalidateOrgSnapshot)(orgUpdated.id);
                console.info(`[user] invalidated org meta for org=${orgUpdated.id}`);
            }
        }
        catch (err) {
            console.warn("Failed to invalidate org meta after profile update:", err);
        }
        // If org has a logo key, attempt to produce a signed URL
        let signedLogoUrl = null;
        if (orgUpdated?.logoUrl) {
            try {
                const command = new client_s3_1.GetObjectCommand({
                    Bucket: process.env.SPACES_BUCKET,
                    Key: orgUpdated.logoUrl,
                });
                signedLogoUrl = await (0, s3_request_presigner_1.getSignedUrl)(spaces_1.spaces, command, {
                    expiresIn: 3600,
                });
            }
            catch (err) {
                console.error("Failed to generate signed url for org logo (Spaces):", err);
            }
        }
        // Build final response object
        const responsePayload = {
            ...updatedUser,
            organization: orgUpdated
                ? {
                    ...orgUpdated,
                    logoUrl: signedLogoUrl ?? orgUpdated.logoUrl,
                }
                : updatedUser.organization ?? null,
        };
        return res.json(responsePayload);
    }
    catch (error) {
        console.error("Error updating profile:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};
exports.updateProfileWithLogo = updateProfileWithLogo;
/**
 * Get current user profile
 */
const getProfile = async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ message: "Unauthorized" });
        const prisma = (0, container_1.getCorePrisma)();
        // Fetch user including orgId and organization's logo key
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: {
                name: true,
                email: true,
                phone: true,
                orgId: true,
                address: true,
                city: true,
                state: true,
                pincode: true,
                panNumber: true,
                organization: {
                    select: {
                        id: true,
                        name: true,
                        dbName: true,
                        logoUrl: true, // this is the Spaces key stored in the DB
                    },
                },
            },
        });
        if (!user)
            return res.status(404).json({ message: "User not found" });
        // Prepare organization object and sign the logo URL if available
        let organization = null;
        if (user.organization) {
            const org = { ...user.organization };
            if (org.logoUrl) {
                try {
                    const cmd = new client_s3_1.GetObjectCommand({
                        Bucket: process.env.SPACES_BUCKET,
                        Key: org.logoUrl,
                    });
                    // 1 hour expiry (3600s). Adjust if you prefer longer/shorter.
                    const signed = await (0, s3_request_presigner_1.getSignedUrl)(spaces_1.spaces, cmd, { expiresIn: 3600 });
                    org.logoUrl = signed;
                }
                catch (err) {
                    // If signing fails, log and keep the raw key (or set to null)
                    console.error("Failed to generate signed url for org logo (Spaces):", err);
                    // Option A: return the raw key (client will need to request signed URL separately)
                    // org.logoUrl = org.logoUrl;
                    // Option B: hide logo if signing fails
                    org.logoUrl = null;
                }
            }
            organization = org;
        }
        // Build and send response — keep same top-level shape your frontend expects
        const responsePayload = {
            name: user.name,
            email: user.email,
            phone: user.phone,
            orgId: user.orgId,
            address: user.address,
            city: user.city,
            state: user.state,
            pincode: user.pincode,
            panNumber: user.panNumber,
            organization,
        };
        return res.json(responsePayload);
    }
    catch (error) {
        console.error("Error fetching profile:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};
exports.getProfile = getProfile;
/**
 * Update current user profile (email cannot be changed)
 */
const updateProfile = async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ message: "Unauthorized" });
        const prisma = (0, container_1.getCorePrisma)();
        const { name, phone, address, city, state, pincode, panNumber } = req.body;
        const updatedUser = await prisma.user.update({
            where: { id: req.user.id },
            data: {
                name,
                phone,
                address: address ?? null,
                city: city ?? null,
                state: state ?? null,
                pincode: pincode ?? null,
                panNumber: panNumber ?? null,
            },
            select: {
                name: true,
                email: true,
                phone: true,
                role: true,
                address: true,
                city: true,
                state: true,
                pincode: true,
            },
        });
        res.json(updatedUser);
    }
    catch (error) {
        console.error("Error updating profile:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};
exports.updateProfile = updateProfile;
/**
 * Invite a new employee to the organization
 */
const inviteUser = async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ message: "Unauthorized" });
        const { email, name, phone, address, city, state, pincode, role, panNumber, } = req.body;
        if (req.user.role !== "ADMIN") {
            return res
                .status(403)
                .json({ message: "Only admins can invite employees" });
        }
        const prisma = (0, container_1.getCorePrisma)();
        const orgId = req.user.orgId;
        if (!orgId) {
            return res
                .status(400)
                .json({ message: "Admin does not belong to any organization" });
        }
        // Seat enforcement
        const seat = await resolveSeatContext(req);
        if (seat.used >= seat.licensed) {
            return res.status(409).json({
                code: "SEAT_LIMIT_REACHED",
                isTrial: seat.isTrial,
                licensed: seat.licensed,
                used: seat.used,
                message: seat.isTrial
                    ? "Trial includes 3 seats. Convert to paid to add more."
                    : "You’ve reached your licensed seat limit.",
            });
        }
        const allowedRoles = ["ADMIN", "EMPLOYEE", "MANAGER"];
        const incomingRole = (role || "").toUpperCase();
        const safeRole = allowedRoles.includes(incomingRole)
            ? incomingRole
            : "EMPLOYEE";
        const normalizedEmail = (email || "").trim().toLowerCase();
        if (!normalizedEmail) {
            return res.status(400).json({ message: "Email is required" });
        }
        // Check if email already exists
        const existingUser = await prisma.user.findUnique({
            where: { email: normalizedEmail },
        });
        if (existingUser) {
            return res
                .status(400)
                .json({ message: "User with this email already exists" });
        }
        // Generate temp password
        const plainPassword = Math.random().toString(36).slice(-8);
        const hashedPassword = await bcrypt_1.default.hash(plainPassword, 10);
        const newUser = await prisma.user.create({
            data: {
                email: normalizedEmail,
                name,
                panNumber,
                role: safeRole,
                status: "INVITED",
                password: hashedPassword,
                orgId,
                isVerified: false,
                phone: phone || null,
                address: address ?? null,
                city: city ?? null,
                state: state ?? null,
                pincode: pincode ?? null,
            },
            select: {
                id: true,
                email: true,
                status: true,
                name: true,
            },
        });
        await (0, mailerSend_1.sendInviteEmail)(normalizedEmail, name || "there", plainPassword);
        const remaining = Math.max(seat.licensed - (seat.used + 1), 0);
        return res.status(201).json({
            message: "Employee invited successfully",
            user: newUser,
            seats: { licensed: seat.licensed, used: seat.used + 1, remaining },
        });
    }
    catch (error) {
        console.error("Invite error:", error);
        res.status(500).json({ message: "Server error" });
    }
};
exports.inviteUser = inviteUser;
// Change password for logged-in user
const changePassword = async (req, res) => {
    if (!req.user)
        return res.status(401).json({ message: "Unauthorized" });
    const prisma = (0, container_1.getCorePrisma)();
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
        return res
            .status(400)
            .json({ message: "Both old and new password are required" });
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) {
        return res.status(404).json({ message: "User not found" });
    }
    const isMatch = await bcrypt_1.default.compare(oldPassword, user.password);
    if (!isMatch) {
        return res.status(400).json({ message: "Old password is incorrect" });
    }
    const hashedPassword = await bcrypt_1.default.hash(newPassword, 10);
    await prisma.user.update({
        where: { id: req.user.id },
        data: { password: hashedPassword },
    });
    return res.status(200).json({ message: "Password changed successfully" });
};
exports.changePassword = changePassword;
/**
 * Get all users in the admin's organization
 */
const getAllUsers = async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ message: "Unauthorized" });
        const prisma = (0, container_1.getCorePrisma)();
        const users = await prisma.user.findMany({
            where: { orgId: req.user.orgId },
            select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                role: true,
                panNumber: true,
                status: true,
                address: true,
                city: true,
                state: true,
                pincode: true,
            },
            orderBy: { createdAt: "desc" },
        });
        return res.json(users);
    }
    catch (error) {
        console.error("Error fetching users:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};
exports.getAllUsers = getAllUsers;
/**
 * Edit a user's details (admin only)
 */
const editUser = async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ message: "Unauthorized" });
        if (req.user.role !== "ADMIN") {
            return res.status(403).json({ message: "Only admins can edit users" });
        }
        const prisma = (0, container_1.getCorePrisma)();
        const { id } = req.params;
        const { name, phone, role, status, address, city, state, pincode, panNumber, } = req.body;
        // Ensure target user is in same org
        const existingUser = await prisma.user.findFirst({
            where: { id: id, orgId: req.user.orgId },
        });
        if (!existingUser) {
            return res.status(404).json({ message: "User not found" });
        }
        // Optional: prevent admin from editing themselves
        // if (existingUser.id === req.user.id) {
        //   return res.status(400).json({ message: "You cannot edit yourself" });
        // }
        const updatedUser = await prisma.user.update({
            where: { id: id },
            data: {
                name: name ?? existingUser.name,
                phone: phone ?? existingUser.phone,
                role: role ?? existingUser.role,
                panNumber: panNumber ?? existingUser.panNumber,
                status: status ?? existingUser.status,
                address: address ?? existingUser.address,
                city: city ?? existingUser.city,
                state: state ?? existingUser.state,
                pincode: pincode ?? existingUser.pincode,
            },
            select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                panNumber: true,
                role: true,
                status: true,
                address: true,
                city: true,
                state: true,
                pincode: true,
            },
        });
        return res.json({
            message: "User updated successfully",
            user: updatedUser,
        });
    }
    catch (error) {
        console.error("Error editing user:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};
exports.editUser = editUser;
/**
 * Delete a user (admin only)
 */
const deleteUser = async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ message: "Unauthorized" });
        if (req.user.role !== "ADMIN") {
            return res.status(403).json({ message: "Only admins can delete users" });
        }
        const prisma = (0, container_1.getCorePrisma)();
        const { id } = req.params;
        // Ensure target user is in same org
        const existingUser = await prisma.user.findFirst({
            where: { id: id, orgId: req.user.orgId },
        });
        if (!existingUser) {
            return res.status(404).json({ message: "User not found" });
        }
        // Prevent admin from deleting themselves
        if (existingUser.id === req.user.id) {
            return res.status(400).json({ message: "You cannot delete yourself" });
        }
        await prisma.refreshToken.deleteMany({ where: { userId: id } });
        await prisma.user.delete({ where: { id: id } });
        return res.json({ message: "User deleted successfully" });
    }
    catch (error) {
        console.error("Error deleting user:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};
exports.deleteUser = deleteUser;
const bulkInviteUsers = async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ message: "Unauthorized" });
        if (req.user.role !== "ADMIN") {
            return res.status(403).json({ message: "Only admins can invite users" });
        }
        const prisma = (0, container_1.getCorePrisma)();
        const orgId = req.user.orgId;
        if (!orgId) {
            return res
                .status(400)
                .json({ message: "Admin does not belong to any organization" });
        }
        const { users } = req.body;
        if (!Array.isArray(users) || users.length === 0) {
            return res.status(400).json({ message: "No users data provided" });
        }
        // Seat context
        const seat = await resolveSeatContext(req);
        let available = Math.max(seat.licensed - seat.used, 0);
        if (available <= 0) {
            return res.status(409).json({
                code: "SEAT_LIMIT_REACHED",
                isTrial: seat.isTrial,
                licensed: seat.licensed,
                used: seat.used,
                message: seat.isTrial
                    ? "Trial includes 3 seats. Convert to paid to add more."
                    : "You’ve reached your licensed seat limit.",
            });
        }
        const results = [];
        let createdCount = 0;
        for (const u of users) {
            if (available <= 0) {
                results.push({
                    email: null,
                    status: "skipped",
                    reason: "No seats remaining",
                });
                continue;
            }
            const Name = u.Name || u.name;
            const Email = (u.Email || u.email || "").toString().trim().toLowerCase();
            const Phone = u.Phone || u.phone;
            const Role = (u.Role || u.role || "EMPLOYEE").toString().toUpperCase();
            const PanNumber = u.PanNumber || u.panNumber;
            const Address = u.Address ?? u.address ?? null;
            const City = u.City ?? u.city ?? null;
            const State = u.State ?? u.state ?? null;
            const Pincode = u.Pincode ?? u.pincode ?? null;
            if (!Email || !Name) {
                results.push({
                    email: Email || null,
                    status: "skipped",
                    reason: "Missing name or email",
                });
                continue;
            }
            // Already exists?
            const existingUser = await prisma.user.findUnique({
                where: { email: Email },
            });
            if (existingUser) {
                results.push({
                    email: Email,
                    status: "skipped",
                    reason: "User already exists",
                });
                continue;
            }
            // Seat check per user
            if (available <= 0) {
                results.push({
                    email: Email,
                    status: "skipped",
                    reason: "No seats remaining",
                });
                continue;
            }
            const allowedRoles = ["ADMIN", "EMPLOYEE", "MANAGER"];
            const safeRole = allowedRoles.includes(Role) ? Role : "EMPLOYEE";
            // Create user with temp password
            const plainPassword = Math.random().toString(36).slice(-8);
            const hashedPassword = await bcrypt_1.default.hash(plainPassword, 10);
            const newUser = await prisma.user.create({
                data: {
                    email: Email,
                    name: Name,
                    phone: Phone || null,
                    panNumber: PanNumber || null,
                    role: safeRole,
                    status: "INVITED",
                    password: hashedPassword,
                    orgId,
                    isVerified: false,
                    address: Address,
                    city: City,
                    state: State,
                    pincode: Pincode,
                },
                select: { id: true, email: true, name: true },
            });
            await (0, mailerSend_1.sendInviteEmail)(newUser.email, newUser.name, plainPassword);
            createdCount += 1;
            available -= 1;
            results.push({ email: newUser.email, status: "invited" });
        }
        return res.json({
            message: "Bulk invite processed",
            invited: createdCount,
            remainingSeats: available,
            licensed: seat.licensed,
            used: seat.used + createdCount,
            results,
        });
    }
    catch (error) {
        console.error("Bulk invite error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};
exports.bulkInviteUsers = bulkInviteUsers;
