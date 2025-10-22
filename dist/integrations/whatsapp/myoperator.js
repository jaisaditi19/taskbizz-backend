"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTaskBizzServiceUpdate = sendTaskBizzServiceUpdate;
exports.testMyOperatorConfig = testMyOperatorConfig;
exports.sendTestMessage = sendTestMessage;
const axios_1 = __importDefault(require("axios"));
// Environment configuration
const BASE_URL = "https://publicapi.myoperator.co/chat/messages";
const API_KEY = process.env.MYOPERATOR_API_KEY;
const COMPANY_ID = process.env.MYOP_COMPANY_ID;
const PHONE_NUMBER_ID = process.env.MYOP_PHONE_NUMBER_ID;
const TEMPLATE_NAME = process.env.MYOP_TEMPLATE_SERVICE_UPDATE || "taskbizz_update";
/**
 * Normalize phone number to E.164 format for Indian numbers
 */
function toE164IN(raw) {
    if (!raw)
        return null;
    // Remove all non-digit characters
    const digits = raw.replace(/\D/g, "");
    // Handle various Indian phone formats
    if (digits.startsWith("91") && digits.length === 12) {
        return "+" + digits;
    }
    if (digits.length === 10) {
        return "+91" + digits;
    }
    return null;
}
/**
 * Validate required template parameters
 */
function validateTemplateParams(params) {
    const errors = [];
    if (!params.organizationName?.trim()) {
        errors.push("organizationName is required");
    }
    if (!params.work?.trim()) {
        errors.push("work/title is required");
    }
    if (!params.dueDate?.trim()) {
        errors.push("dueDate is required");
    }
    return {
        valid: errors.length === 0,
        errors,
    };
}
/**
 * Send TaskBizz service update via MyOperator WhatsApp
 *
 * Template: "Update from {{orgname}}"
 * Body: "Dear {{client}}, Service update for the assigned work..."
 *
 * Template Structure:
 * - Header: 1 parameter {{orgname}}
 * - Body: 5 parameters {{client}}, {{title}}, {{due}}, {{assigned}}, {{status}}
 *
 * Template Parameters (in order):
 * 1. {{orgname}} - Organization name (header)
 * 2. {{client}} - Client name
 * 3. {{title}} - Work/task title
 * 4. {{due}} - Due date (format: DD/MM/YYYY recommended)
 * 5. {{assigned}} - Assigned person name
 * 6. {{status}} - Task status (e.g., OPEN, IN_PROGRESS, COMPLETED)
 */
async function sendTaskBizzServiceUpdate(params) {
    // Validate phone number
    const e164Phone = toE164IN(params.phone);
    if (!e164Phone) {
        const error = `[MyOperator] Invalid phone number: ${params.phone}`;
        console.warn(error);
        return { success: false, error };
    }
    // Extract customer number (without country code)
    const customer_number = e164Phone.replace(/^\+91/, "");
    // Validate template parameters
    const validation = validateTemplateParams(params);
    if (!validation.valid) {
        const error = `[MyOperator] Invalid parameters: ${validation.errors.join(", ")}`;
        console.error(error);
        return { success: false, error };
    }
    // Build template parameters array (must match template order exactly)
    // Note: Each parameter must be non-empty string for WhatsApp templates
    const paramStrings = [
        String(params.organizationName).trim(), // {{orgname}} - Header
        String(params.clientName || "Valued Client").trim(), // {{client}}
        String(params.work).trim(), // {{title}}
        String(params.dueDate).trim(), // {{due}} - Should be DD/MM/YYYY
        String(params.assignedTo || "Team").trim(), // {{assigned}}
        String(params.status || "PENDING").trim(), // {{status}}
    ];
    // Ensure no empty strings (WhatsApp template requirement)
    const hasEmptyParam = paramStrings.some((p) => !p || p.length === 0);
    if (hasEmptyParam) {
        const error = `[MyOperator] Template parameters cannot be empty. Params: ${JSON.stringify(paramStrings)}`;
        console.error(error);
        return { success: false, error };
    }
    // Convert to WhatsApp components format
    // Based on your template: header has {{orgname}}, body has 5 params
    const components = [
        {
            type: "header",
            parameters: [
                {
                    type: "text",
                    text: paramStrings[0], // {{orgname}}
                },
            ],
        },
        {
            type: "body",
            parameters: paramStrings.slice(1).map((text) => ({
                type: "text",
                text: text,
            })),
        },
    ];
    // Construct API payload
    // MyOperator expects template parameters in WhatsApp components format
    // … keep everything above the same …
    const payload = {
        phone_number_id: PHONE_NUMBER_ID,
        customer_country_code: "91",
        customer_number,
        data: {
            type: "template",
            language: "en", // string here ✅
            context: {
                template_name: TEMPLATE_NAME, // e.g. "taskbizz_update"
                // namespace: process.env.MYOP_NAMESPACE, // add if required by your account
                body: {
                    orgname: paramStrings[0],
                    client: paramStrings[1],
                    title: paramStrings[2],
                    due: paramStrings[3],
                    assigned: paramStrings[4],
                    status: paramStrings[5],
                },
            },
        },
        reply_to: null,
        myop_ref_id: params.refId || `TASK-${Date.now()}-${customer_number}`,
    };
    try {
        console.log(`[MyOperator WA] Sending to +91${customer_number}...`);
        console.log(`[MyOperator WA] Template: ${TEMPLATE_NAME}`);
        console.log(`[MyOperator WA] Params:`, paramStrings);
        console.log(`[MyOperator WA] Full Payload:`, JSON.stringify(payload, null, 2));
        const response = await axios_1.default.post(BASE_URL, payload, {
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                "X-MYOP-COMPANY-ID": COMPANY_ID,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            timeout: 15000,
            validateStatus: (status) => status < 500, // Don't throw on 4xx
        });
        // Check response status
        if (response.status >= 200 && response.status < 300) {
            console.log("[MyOperator WA] ✅ Success:", {
                status: response.status,
                data: response.data,
            });
            return {
                success: true,
                messageId: response.data?.message_id || response.data?.id,
            };
        }
        else {
            // Deep log the error for debugging
            console.error("[MyOperator WA] ❌ API Error:", {
                status: response.status,
                error: response.data,
                errorDetails: JSON.stringify(response.data, null, 2),
            });
            console.error("[MyOperator WA] ❌ Sent Payload:", JSON.stringify(payload, null, 2));
            return {
                success: false,
                error: `API returned ${response.status}: ${JSON.stringify(response.data)}`,
            };
        }
    }
    catch (err) {
        const errorMsg = err?.response?.data?.message || err?.message || "Unknown error";
        console.error("[MyOperator WA] ❌ Request Failed:", {
            error: errorMsg,
            status: err?.response?.status,
            responseData: err?.response?.data,
            sentPayload: JSON.stringify(payload, null, 2),
        });
        return {
            success: false,
            error: errorMsg,
        };
    }
}
/**
 * Test function to verify configuration
 */
async function testMyOperatorConfig() {
    const requiredVars = {
        API_KEY: process.env.MYOPERATOR_API_KEY,
        COMPANY_ID: process.env.MYOP_COMPANY_ID,
        PHONE_NUMBER_ID: process.env.MYOP_PHONE_NUMBER_ID,
    };
    const missing = Object.entries(requiredVars)
        .filter(([_, value]) => !value)
        .map(([key]) => key);
    if (missing.length > 0) {
        console.error(`[MyOperator] Missing env vars: ${missing.join(", ")}`);
    }
    else {
        console.log("[MyOperator] ✅ Configuration OK");
        console.log(`[MyOperator] Template: ${TEMPLATE_NAME}`);
    }
}
/**
 * Send a test message to verify template integration
 */
async function sendTestMessage(testPhone) {
    console.log("\n=== MyOperator Template Test ===");
    console.log("Template: Update from {{orgname}}");
    console.log("Expected body format:");
    console.log("Dear {{client}},");
    console.log("Service update for the assigned work :");
    console.log("Work : {{title}}");
    console.log("Due Date: {{due}}");
    console.log("Assigned To: {{assigned}}");
    console.log("Current Status: {{status}}");
    console.log("*Do Not reply on this number.*");
    console.log("\n");
    const result = await sendTaskBizzServiceUpdate({
        phone: testPhone,
        organizationName: "TestOrg",
        clientName: "Test Client",
        work: "Sample Task Testing",
        dueDate: new Date().toLocaleDateString("en-IN"),
        assignedTo: "John Doe",
        status: "OPEN",
        refId: `TEST-${Date.now()}`,
    });
    console.log("\nTest Result:", result);
}
