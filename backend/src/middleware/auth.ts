/**
 * Authentication middleware — verifies Supabase JWTs with the anon key only
 * (never the service role). Identity is bound on the request for downstream routes.
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { NextFunction, Request, Response } from "express";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
        "SUPABASE_URL and SUPABASE_ANON_KEY are required for JWT verification (auth middleware)."
    );
}

const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
});

export interface AuthedRequest extends Request {
    user: { id: string; email?: string };
}

export const requireAuth = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith("Bearer ")) {
            res.status(401).json({ error: "Unauthorized: Missing token" });
            return;
        }

        const token = authHeader.split(" ")[1];
        const {
            data: { user },
            error,
        } = await supabaseAuth.auth.getUser(token);

        if (error || !user) {
            res.status(401).json({ error: "Unauthorized: Invalid token" });
            return;
        }

        (req as AuthedRequest).user = { id: user.id, email: user.email ?? undefined };
        next();
    } catch (err) {
        console.error("Auth middleware error:", err);
        res.status(500).json({ error: "Authentication failed" });
    }
};
