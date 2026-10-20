import swaggerJsdoc from "swagger-jsdoc";


const servers = [
  {
    url: `http://localhost:${process.env.PORT}`,
    description: "Local server",
  },
  {
    url: process.env.API_URL_DEV,
    description: "Development server",
  },
  {
    url: process.env.API_URL_PROD,
    description: "Production server",
  },
].filter((s) => s.url); // remove undefined

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "MuMu API",
      version: "1.0.0",
      description: "Messaging-first social app on MUMU RTC. Sign in with crypt-iam (client `mu`); set `x-profile-id` to act as one of your business profiles.",
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
        activeProfile: {
          type: "apiKey",
          in: "header",
          name: "x-profile-id",
          description: "Act as this profile (one you own or administer). Default: your personal profile.",
        },
      },
    },
    security: [{ bearerAuth: [], activeProfile: [] }, { bearerAuth: [] }],
    servers,
  },
  apis: ["./src/routes.ts", "./src/**/*.routes.ts", "./src/**/*.dto.ts"],
});