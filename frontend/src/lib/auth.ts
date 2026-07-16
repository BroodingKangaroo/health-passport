import { NextAuthOptions, DefaultSession } from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials"

declare module "next-auth" {
  interface Session {
    accessToken?: string
    user: {
      id: string
    } & DefaultSession["user"]
  }
  interface User {
    accessToken?: string
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null
        }

        try {
          const base = process.env.STATIC_PROXY_URL || 'http://localhost:8000'
          const res = await fetch(`${base}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              username: credentials.email,
              password: credentials.password,
            }),
          })

          if (!res.ok) {
            const errorData = await res.json().catch(() => ({ detail: "Login failed" }))
            console.error("Login failed:", res.status, errorData)
            return null
          }

          const data = await res.json()
          
          const userRes = await fetch(`${base}/api/auth/me`, {
            headers: { Authorization: `Bearer ${data.access_token}` },
          })

          if (!userRes.ok) {
            console.error("Failed to fetch user:", userRes.status)
            return null
          }

          const user = await userRes.json()
          
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            accessToken: data.access_token,
          }
        } catch (error) {
          console.error("Auth error:", error)
          return null
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.accessToken = user.accessToken
        token.id = user.id
      }
      return token
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken
      session.user.id = token.id as string
      return session
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
  secret: process.env.NEXTAUTH_SECRET,
}