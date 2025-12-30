import { Request, Response } from "express";
import { getCorePrisma } from "../di/container";

/**
 * Add a new department (Admin only)
 */
export const addDepartment = async (
  req: Request & { user?: any },
  res: Response
) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (req.user.role !== "ADMIN") {
      return res
        .status(403)
        .json({ message: "Only admins can add departments" });
    }

    const prisma = getCorePrisma();
    const orgId = req.user.orgId;

    if (!orgId) {
      return res
        .status(400)
        .json({ message: "User does not belong to an organization" });
    }

    const { name } = req.body as { name?: string };

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Department name is required" });
    }

    const normalizedName = name.trim();

    // Prevent duplicate departments in same org
    const existing = await prisma.department.findFirst({
      where: {
        orgId,
        name: {
          equals: normalizedName,
          mode: "insensitive", // case-insensitive
        },
      },
    });

    if (existing) {
      return res.status(409).json({
        message: "Department already exists",
        department: existing,
      });
    }

    const department = await prisma.department.create({
      data: {
        name: normalizedName,
        orgId,
      },
      select: {
        id: true,
        name: true,
        createdAt: true,
      },
    });

    return res.status(201).json({
      message: "Department created successfully",
      department,
    });
  } catch (error) {
    console.error("Error creating department:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const getDepartments = async (
  req: Request & { user?: any },
  res: Response
) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const prisma = getCorePrisma();
    const orgId = req.user.orgId;

    if (!orgId) {
      return res
        .status(400)
        .json({ message: "User does not belong to an organization" });
    }

    const departments = await prisma.department.findMany({
      where: { orgId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        createdAt: true,
        _count: {
          select: { users: true },
        },
      },
    });

    return res.json(departments);
  } catch (error) {
    console.error("Error fetching departments:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * Rename department
 */
export const updateDepartment = async (
  req: Request & { user?: any },
  res: Response
) => {
  try {
    if (!req.user || req.user.role !== "ADMIN") {
      return res.status(403).json({ message: "Only admins can edit departments" });
    }

    const prisma = getCorePrisma();
    const orgId = req.user.orgId;
    const { id } = req.params;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Department name is required" });
    }

    const department = await prisma.department.findFirst({
      where: { id, orgId },
    });

    if (!department) {
      return res.status(404).json({ message: "Department not found" });
    }

    // Prevent duplicate rename
    const duplicate = await prisma.department.findFirst({
      where: {
        orgId,
        name: { equals: name.trim(), mode: "insensitive" },
        NOT: { id },
      },
    });

    if (duplicate) {
      return res
        .status(409)
        .json({ message: "Department with same name already exists" });
    }

    const updated = await prisma.department.update({
      where: { id },
      data: { name: name.trim() },
      select: { id: true, name: true, createdAt: true },
    });

    return res.json(updated);
  } catch (error) {
    console.error("Error updating department:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * Delete department (only if empty)
 */
export const deleteDepartment = async (
  req: Request & { user?: any },
  res: Response
) => {
  try {
    if (!req.user || req.user.role !== "ADMIN") {
      return res.status(403).json({ message: "Only admins can delete departments" });
    }

    const prisma = getCorePrisma();
    const orgId = req.user.orgId;
    const { id } = req.params;

    const department = await prisma.department.findFirst({
      where: { id, orgId },
      include: {
        _count: { select: { users: true } },
      },
    });

    if (!department) {
      return res.status(404).json({ message: "Department not found" });
    }

    if (department._count.users > 0) {
      return res.status(409).json({
        message: "Department has users assigned. Reassign users first.",
        usersCount: department._count.users,
      });
    }

    await prisma.department.delete({ where: { id } });

    return res.json({ message: "Department deleted successfully" });
  } catch (error) {
    console.error("Error deleting department:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};
