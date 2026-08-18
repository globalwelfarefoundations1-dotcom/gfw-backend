import jwt from "jsonwebtoken";

if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET) {
  throw new Error("Missing JWT_ACCESS_SECRET or JWT_REFRESH_SECRET environment variables");
}

const accessSecret: string = process.env.JWT_ACCESS_SECRET;
const refreshSecret: string = process.env.JWT_REFRESH_SECRET;

const ACCESS_TOKEN_EXPIRES_IN = "15m";
const REFRESH_TOKEN_EXPIRES_IN = "7d";

export interface TokenPayload {
  id: number;
  email: string;
}

export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, accessSecret, { expiresIn: ACCESS_TOKEN_EXPIRES_IN });
}

export function signRefreshToken(payload: TokenPayload): string {
  return jwt.sign(payload, refreshSecret, { expiresIn: REFRESH_TOKEN_EXPIRES_IN });
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, accessSecret) as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  return jwt.verify(token, refreshSecret) as TokenPayload;
}
