// generate-module.ts
import * as fs from 'fs';
import * as path from 'path';

// get module name from command line
const args = process.argv.slice(2);

// Check that exactly **one argument** is provided
if (args.length !== 1) {
  console.error('Invalid module name: provide exactly one module name without spaces.');
  console.error('Example: npm run generate-module clientRole');
  process.exit(1);
}

const moduleInput = args[0];

// Reject if input contains spaces
if (/\s/.test(moduleInput)) {
  console.error('Invalid module name: spaces are not allowed. Use camelCase, kebab-case or snake_case.');
  process.exit(1);
}

if (!moduleInput) {
  console.error('Please provide a module name: npm run generate-module <module-name>');
  process.exit(1);
}

// Convert any input to camelCase
const moduleName = moduleInput.includes('-') || moduleInput.includes('_') || moduleInput.includes(' ')
  ? moduleInput
      .toLowerCase()
      .replace(/[-_\s]+(.)/g, (_, c) => c.toUpperCase())
  : moduleInput; // preserve existing camelCase

console.log("moduleName: ", moduleName)

// Convert any input (camelCase, PascalCase, snake_case, spaces) to kebab-case
const fileName = moduleName
  .replace(/([a-z])([A-Z])/g, '$1-$2') // add dash before uppercase letters
  .toLowerCase();                       // lowercase everything

console.log("fileName: ", fileName)


const basePath = path.join(__dirname, '..', 'src', 'modules', fileName);

// Create folder
if (!fs.existsSync(basePath)) {
  fs.mkdirSync(basePath, { recursive: true });
}

// Capitalize first letter
const ModuleClassName = moduleName.charAt(0).toUpperCase() + moduleName.slice(1);

// Service
const serviceContent = `import { Create${ModuleClassName}Dto, Update${ModuleClassName}Dto, Create${ModuleClassName}Response, Update${ModuleClassName}Response, Get${ModuleClassName}Response, List${ModuleClassName}Response } from "./${fileName}.dto";
import { Prisma } from "@prisma/client";
import prisma from '../../prisma/client';
import { PaginationRequestDto } from "../common/common.dto";


export class ${ModuleClassName}Service {
  constructor() {}

  async create(payload: Create${ModuleClassName}Dto): Promise<Create${ModuleClassName}Response> {
    try {
      // TODO: create ${ModuleClassName} in database
      return {
        ${moduleName}Id: "generated-${moduleName}Id",
        ...payload,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      throw error;
    }
  }

  async update(${moduleName}Id: string, payload: Update${ModuleClassName}Dto): Promise<Update${ModuleClassName}Response> {
    try {
      // TODO: update ${ModuleClassName} by ${moduleName}Id
      return {
        ${moduleName}Id,
        ...payload,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      throw error;
    }
  }

  async getById(${moduleName}Id: string): Promise<Get${ModuleClassName}Response> {
    try {
      // TODO: fetch ${ModuleClassName} by ${moduleName}Id
      return {
        ${moduleName}Id,
        name: "Sample ${ModuleClassName}",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      throw error;
    }
  }

  async list({
    offset = 0,
    limit = 20,
    search,
    sortBy = "createdAt",
    sortOrder = "desc",
  }: PaginationRequestDto): Promise<{ items: List${ModuleClassName}Response; total: number }> {
    try {
      // TODO: fetch list of ${ModuleClassName}
      return {
        total: 1,
        items: [
          {
            ${moduleName}Id: "1",
            name: "Sample ${ModuleClassName} 1",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ]
      }
    } catch (error) {
      throw error;
    }
  }

  async delete(${moduleName}Id: string): Promise<void> {
    try {
      // TODO: delete ${ModuleClassName} by ${moduleName}Id
      return;
    } catch (error) {
      throw error;
    }
  }
}

export default new ${ModuleClassName}Service()
`;

fs.writeFileSync(path.join(basePath, `${fileName}.service.ts`), serviceContent);

// Controller
const controllerContent = `
import { Request, Response } from 'express';
import { ${ModuleClassName}Service } from './${fileName}.service';
import { 
  Create${ModuleClassName}Dto, 
  Update${ModuleClassName}Dto, 
  Create${ModuleClassName}ResponseDto,
  Update${ModuleClassName}ResponseDto,
  Get${ModuleClassName}ResponseDto,
  List${ModuleClassName}ResponseDto
} from './${fileName}.dto';
import { PaginationRequestDto } from '../common/common.dto';

export class ${ModuleClassName}Controller {
  constructor(private ${moduleName}Service: ${ModuleClassName}Service) {}

  async create(req: Request, res: Response) {
    try {
      const payload: Create${ModuleClassName}Dto = req.body;
      const data = await this.${moduleName}Service.create(payload);
      const response: Create${ModuleClassName}ResponseDto = {
        success: true,
        status: 201,
        message: '${ModuleClassName} created successfully',
        data,
      };
      res.status(201).json(response);
    } catch (error: any) {
      res.status(500).json({ success: false, status: 500, message: error.message });
    }
  }

  async update(req: Request, res: Response) {
    try {
      const ${moduleName}Id = req.params.${moduleName}Id as string;
      const payload: Update${ModuleClassName}Dto = req.body;
      const data = await this.${moduleName}Service.update(${moduleName}Id, payload);
      const response: Update${ModuleClassName}ResponseDto = {
        success: true,
        status: 200,
        message: '${ModuleClassName} updated successfully',
        data,
      };
      res.json(response);
    } catch (error: any) {
      res.status(500).json({ success: false, status: 500, message: error.message });
    }
  }

  async getById(req: Request, res: Response) {
    try {
      const ${moduleName}Id = req.params.${moduleName}Id as string;
      const data = await this.${moduleName}Service.getById(${moduleName}Id);
      const response: Get${ModuleClassName}ResponseDto = {
        success: true,
        status: 200,
        message: '${ModuleClassName} fetched successfully',
        data,
      };
      res.json(response);
    } catch (error: any) {
      res.status(404).json({ success: false, status: 404, message: error.message });
    }
  }

  async list(req: Request, res: Response) {
    try {
      const query = req.query as PaginationRequestDto;
  
      const offset = query.offset ? Number(query.offset) : 0;
      const limit = query.limit ? Number(query.limit) : 20;
      const search = query.search;
      const sortBy = query.sortBy || "createdAt";
      const sortOrder = query.sortOrder || "desc";
      const { items, total } =
        await this.${moduleName}Service.list({
          offset,
          limit,
          search,
          sortBy,
          sortOrder,
        });
  
      const response: List${ModuleClassName}ResponseDto = {
        success: true,
        status: 200,
        message: "${ModuleClassName} list fetched successfully",
        data: {
          items,
          total,
          offset,
          limit,
        },
      };
      res.json(response);
    } catch (error: any) {
      res.status(500).json({ success: false, status: 500, message: error.message });
    }
  }

  async delete(req: Request, res: Response) {
    try {
      const ${moduleName}Id = req.params.${moduleName}Id as string;
      await this.${moduleName}Service.delete(${moduleName}Id);
      res.json({
        success: true,
        status: 200,
        message: '${ModuleClassName} deleted successfully',
      });
    } catch (error: any) {
      res.status(500).json({ success: false, status: 500, message: error.message });
    }
  }
}
`;

fs.writeFileSync(path.join(basePath, `${fileName}.controller.ts`), controllerContent);

// Routes
const routesContent = `
import express, { Router } from 'express';
import { ${ModuleClassName}Controller } from './${fileName}.controller';
import { ${moduleName}Middleware } from './${fileName}.middlewares';
import { authMiddleware } from '../../middlewares/auth.middleware';
import ${moduleName}Service from './${fileName}.service';
import { TypeAction, Resource, TypeResource } from '../../utils/consts';
import { authorizationMiddleware } from '../../middlewares/authorization.middleware';

const router: Router = express.Router();
const controller = new ${ModuleClassName}Controller(${moduleName}Service);
router.use(authMiddleware);
const guard = (actions: TypeAction[]) => authorizationMiddleware({ resource: Resource.COMMON, actions, resourceType: TypeResource.API_ENDPOINT });

/**
 * @openapi
 * tags:
 *   - name: ${ModuleClassName}
 *     description: ${ModuleClassName} management and operations
 */

/**
 * @openapi
 * /api/${moduleName}:
 *   post:
 *     tags: [${ModuleClassName}]
 *     summary: Create a new ${ModuleClassName}
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Create${ModuleClassName}Dto'
 *     responses:
 *       201:
 *         description: ${ModuleClassName} created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Create${ModuleClassName}ResponseDto'
 */
router.post('/', ${moduleName}Middleware, guard([TypeAction.CREATE]), controller.create.bind(controller));

/**
 * @openapi
 * /api/${moduleName}/{${moduleName}Id}:
 *   get:
 *     tags: [${ModuleClassName}]
 *     summary: Get a ${ModuleClassName} by ID
 *     parameters:
 *       - name: ${moduleName}Id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: ${ModuleClassName} fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Get${ModuleClassName}ResponseDto'
 */
router.get('/:${moduleName}Id', ${moduleName}Middleware, guard([TypeAction.READ]), controller.getById.bind(controller));

/**
 * @openapi
 * /api/${moduleName}/{${moduleName}Id}:
 *   put:
 *     tags: [${ModuleClassName}]
 *     summary: Update a ${ModuleClassName} by ID
 *     parameters:
 *       - name: ${moduleName}Id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Update${ModuleClassName}Dto'
 *     responses:
 *       200:
 *         description: ${ModuleClassName} updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Update${ModuleClassName}ResponseDto'
 */
router.put('/:${moduleName}Id', ${moduleName}Middleware, guard([TypeAction.UPDATE]), controller.update.bind(controller));

/**
 * @openapi
 * /api/${moduleName}/{${moduleName}Id}:
 *   delete:
 *     tags: [${ModuleClassName}]
 *     summary: Delete a ${ModuleClassName} by ID
 *     parameters:
 *       - name: ${moduleName}Id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: ${ModuleClassName} deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 status:
 *                   type: integer
 *                 message:
 *                   type: string
 */
router.delete('/:${moduleName}Id', ${moduleName}Middleware, guard([TypeAction.DELETE]), controller.delete.bind(controller));

/**
 * @openapi
 * /api/${moduleName}:
 *   get:
 *     tags: [${ModuleClassName}]
 *     summary: List all ${ModuleClassName}s with pagination
 *     parameters:
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *         description: Offset for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Limit for pagination
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search keyword
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *         description: Field to sort by
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *         description: Sort order
 *     responses:
 *       200:
 *         description: List of ${ModuleClassName}s
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/List${ModuleClassName}ResponseDto'
 */
router.get('/', ${moduleName}Middleware, guard([TypeAction.READ_ALL]), controller.list.bind(controller));

/**
 * ======================================================
 * Optional: Health Check
 * ======================================================
 */
router.get('/health/check', (_req, res) => {
  res.json({
    success: true,
    status: 200,
    message: "${ModuleClassName} module is healthy",
  });
});

export default router;
`;


fs.writeFileSync(path.join(basePath, `${fileName}.routes.ts`), routesContent);
const dtoContent = `import { ApiResponse, PaginatedData } from "../common/common.dto";

/**
 * Main ${ModuleClassName} entity
 *
 * @openapi
 * components:
 *   schemas:
 *     ${ModuleClassName}:
 *       type: object
 *       required:
 *         - name
 *       properties:
 *         ${moduleName}Id:
 *           type: string
 *           example: "c3f2a9b4-8d21-4f3b-a91c-1a2b3c4d5e6f"
 *           description: Unique identifier of the ${ModuleClassName}
 *         name:
 *           type: string
 *           example: Sample ${ModuleClassName}
 *           description: Name of the ${ModuleClassName}
 *         description:
 *           type: string
 *           example: Optional description
 *           nullable: true
 *           description: Description of the ${ModuleClassName}
 *         createdAt:
 *           type: string
 *           format: date-time
 *           example: "2025-01-01T10:00:00.000Z"
 *           description: Creation timestamp
 *         updatedAt:
 *           type: string
 *           format: date-time
 *           example: "2025-01-02T12:00:00.000Z"
 *           description: Last update timestamp
 */
export interface ${ModuleClassName} {
  ${moduleName}Id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * @openapi
 * components:
 *   schemas:
 *     Create${ModuleClassName}Dto:
 *       type: object
 *       required:
 *         - name
 *       properties:
 *         name:
 *           type: string
 *           example: Sample ${ModuleClassName}
 *           description: Name of the ${ModuleClassName}
 *         description:
 *           type: string
 *           example: Sample description
 */
export interface Create${ModuleClassName}Dto {
  name: string;
  description?: string;
}

/**
 * @openapi
 * components:
 *   schemas:
 *     Update${ModuleClassName}Dto:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           example: Updated ${ModuleClassName} Name
 *         description:
 *           type: string
 *           example: Updated description
 */
export interface Update${ModuleClassName}Dto {
  name?: string;
  description?: string;
}

/**
 * ======================================================
 * Service return types (data only, controller wraps response)
 * ======================================================
 */

// data returned from service
export type Create${ModuleClassName}Response = Partial<${ModuleClassName}>;
export type Update${ModuleClassName}Response = Partial<${ModuleClassName}>;
export type Get${ModuleClassName}Response = Partial<${ModuleClassName}>;
export type List${ModuleClassName}Response = Partial<${ModuleClassName}>[];

/**
 * ======================================================
 * API Response DTOs (Swagger documented)
 * ======================================================
 */

/**
 * @openapi
 * components:
 *   schemas:
 *     Create${ModuleClassName}ResponseDto:
 *       allOf:
 *         - $ref: '#/components/schemas/ApiResponse'
 *         - type: object
 *           properties:
 *             data:
 *               $ref: '#/components/schemas/${ModuleClassName}'
 */
export interface Create${ModuleClassName}ResponseDto
  extends ApiResponse<Partial<${ModuleClassName}>> {}

/**
 * @openapi
 * components:
 *   schemas:
 *     Update${ModuleClassName}ResponseDto:
 *       allOf:
 *         - $ref: '#/components/schemas/ApiResponse'
 *         - type: object
 *           properties:
 *             data:
 *               $ref: '#/components/schemas/${ModuleClassName}'
 */
export interface Update${ModuleClassName}ResponseDto
  extends ApiResponse<Partial<${ModuleClassName}>> {}

/**
 * @openapi
 * components:
 *   schemas:
 *     Get${ModuleClassName}ResponseDto:
 *       allOf:
 *         - $ref: '#/components/schemas/ApiResponse'
 *         - type: object
 *           properties:
 *             data:
 *               $ref: '#/components/schemas/${ModuleClassName}'
 */
export interface Get${ModuleClassName}ResponseDto
  extends ApiResponse<Partial<${ModuleClassName}>> {}

/**
 * @openapi
 * components:
 *   schemas:
 *     List${ModuleClassName}ResponseDto:
 *       allOf:
 *         - $ref: '#/components/schemas/ApiResponse'
 *         - type: object
 *           properties:
 *             data:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/${ModuleClassName}'
 *                 total:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *                 limit:
 *                   type: integer
 */
export interface List${ModuleClassName}ResponseDto
  extends ApiResponse<PaginatedData<Partial<${ModuleClassName}>>> {}
`;


fs.writeFileSync(path.join(basePath, `${fileName}.dto.ts`), dtoContent);

// Middleware
const middlewareContent = `
import { Request, Response, NextFunction } from "express";
import { iamCacheService } from "../../utils/iam.redis";
import { CachedUserProfilePermissionDto } from "../../utils/redis.dto";

export async function ${moduleName}Middleware(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = req.user!
    const profile = await iamCacheService.get<CachedUserProfilePermissionDto>(\`user:\${userId}:permissions\`);
    if(!profile) throw new Error("No permission found")
    const userPermissions = profile;

    const method = req.method;
    const url = req.originalUrl;
    const path = req.path;
    const ${moduleName}Id = req?.params?.${moduleName}Id

    console.log("---- REALM MIDDLEWARE ----");
    console.log("Method:", method);
    console.log("URL:", url);
    console.log("Path:", path);

    // Example condition checking
    if (method === "POST" && path === "/") {
      console.log("👉 Creating new realm");
    }

    if (method === "GET" && path === "/") {
      console.log("👉 Listing realms");
    }

    if (method === "GET" && ${moduleName}Id) {
      console.log("👉 Getting realm by ID:", ${moduleName}Id);      
    }

    if (method === "PUT") {
      console.log("👉 Updating realm");
    }

    if (method === "DELETE") {
      console.log("👉 Deleting realm");
    }

    next();
  } catch (error) {
    return res.status(500).json({
      message: "Authorization error",
    });
  }
}
`;

fs.writeFileSync(path.join(basePath, `${fileName}.middlewares.ts`), middlewareContent);




const routesFilePath = path.join(__dirname, '..', 'src', 'routes.ts');

if (fs.existsSync(routesFilePath)) {
  let routesFileContent = fs.readFileSync(routesFilePath, 'utf-8');

  const importLine = `import ${moduleName}Routes from "./modules/${fileName}/${fileName}.routes";`;
  const useLine = `routers.use("/api/${fileName}", ${moduleName}Routes);`;

  if (!routesFileContent.includes(importLine)) {
    routesFileContent = routesFileContent.replace(
      '\nconst routers: Router = express.Router();',
      `${importLine}\n\nconst routers: Router = express.Router();`
    );
  }

  if (!routesFileContent.includes(useLine)) {
    routesFileContent = routesFileContent.replace(
      '\nexport default routers;',
      `${useLine}\n\nexport default routers;`
    );
  }

  fs.writeFileSync(routesFilePath, routesFileContent);
  console.log('routes.ts updated successfully');
}



console.log(`Module '${moduleName}' generated successfully at ${basePath}`);