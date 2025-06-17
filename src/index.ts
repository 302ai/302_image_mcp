#!/usr/bin/env node
import { getParamValue, getAuthValue } from "@chatmcp/sdk/utils/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { RestServerTransport } from "@chatmcp/sdk/server/rest.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
// support for mcp.so
const ai302ApiKey = getParamValue("302ai_api_key");
const mode = getParamValue("mode") || "stdio";
const port = getParamValue("port") || 9593;
const endpoint = getParamValue("endpoint") || "/rest";

dotenv.config();

class Logger {
  private logDir: string;
  private logFile: string;

  constructor() {
    this.logDir = path.join(process.cwd(), "logs");
    this.logFile = path.join(this.logDir, "mcp-server.log");
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private formatMessage(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    return data ? `${logMessage} ${JSON.stringify(data)}` : logMessage;
  }

  private writeLog(message: string): void {
    try {
      fs.appendFileSync(this.logFile, message + '\n');
    } catch (error) {
      console.error('Failed to write log:', error);
    }
  }

  info(message: string, data?: any): void {
    const logMessage = this.formatMessage('INFO', message, data);
    console.log(logMessage);
    this.writeLog(logMessage);
  }

  error(message: string, data?: any): void {
    const logMessage = this.formatMessage('ERROR', message, data);
    console.error(logMessage);
    this.writeLog(logMessage);
  }

  debug(message: string, data?: any): void {
    const logMessage = this.formatMessage('DEBUG', message, data);
    console.log(logMessage);
    this.writeLog(logMessage);
  }
}

const logger = new Logger();


class AI302Api {
  private baseUrl = process.env.BASE_URL || "https://api.302.ai/mcp";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    logger.info('AI302Api initialized', { baseUrl: this.baseUrl });
  }

  getApiKey(): string {
    return this.apiKey;
  }

  async listTools(): Promise<Tool[]> {
    const url = new URL(`${this.baseUrl}/v1/tool/list`);
    url.searchParams.append("packId", "imageTools");
    url.searchParams.append("user302", "user302");
    
    logger.debug('Fetching tools list', { url: url.toString() });
    
    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Failed to fetch tools list', { 
          status: response.status, 
          statusText: response.statusText,
          error: errorText 
        });
        throw new McpError(
          ErrorCode.InternalError,
          `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const data = await response.json();
      logger.info('Successfully fetched tools list', { toolsCount: data.tools.length });
      return data.tools;
    } catch (err: any) {
      logger.error('Tools list fetch exception', { error: err.message });
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch tools: ${err.message}`,
      );
    }
  }

  async callTool(name: string, arguments_: any): Promise<any> {
    logger.debug('Calling tool', { name, arguments: arguments_ });
    
    try {
      const requestBody = {
        nameOrId: name,
        arguments: arguments_,
      };

      logger.debug('Request body', { body: requestBody });

      const response = await fetch(`${this.baseUrl}/v1/tool/call`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "x-api-key": this.apiKey,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Tool call failed', { 
          name, 
          status: response.status, 
          statusText: response.statusText,
          error: errorText 
        });
        throw new McpError(
          ErrorCode.InternalError,
          `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      const data = await response.json();
      logger.info('Tool called successfully', { name });
      return data;
    } catch (err: any) {
      logger.error('Tool call exception', { name, error: err.message });
      throw new McpError(
        ErrorCode.InternalError,
        `Tool call failed: ${err.message}`,
      );
    }
  }
}

class AI302Server {
  private server: Server;
  private api: AI302Api | null = null;

  constructor() {
    logger.info('Initializing AI302Server');
    
    this.server = new Server(
      {
        name: "302ai-image-mcp",
        version: "0.1.2",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      },
    );

    this.setupHandlers();
    this.setupErrorHandling();
    
    logger.info('AI302Server initialized successfully');
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      logger.error('MCP Server error', { error: error.message });
      console.error("[MCP Error]", error);
    };

    process.on("SIGINT", async () => {
      logger.info('Received SIGINT, shutting down server');
      await this.server.close();
      process.exit(0);
    });
  }

  private setupHandlers(): void {
    this.setupToolHandlers();
  }

  private getApiInstance(request?: any): AI302Api {
    const apiKey =
      ai302ApiKey ||
      (request && getAuthValue(request, "302AI_API_KEY")) ||
      process.env["302AI_API_KEY"];
      
    if (!apiKey) {
      logger.error('API key is missing');
      throw new McpError(
        ErrorCode.InvalidParams,
        "API key is required to call the tool",
      );
    }

    if (!this.api || this.api.getApiKey() !== apiKey) {
      logger.debug('Creating new API instance');
      this.api = new AI302Api(apiKey);
    }

    return this.api;
  }

  private async setupToolHandlers(): Promise<void> {
    this.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      logger.debug('Handling list tools request');
      
      // Re-fetch tools with request-specific API key if available
      const api = this.getApiInstance(request);
      const tools = await api.listTools();
      
      logger.info('List tools request completed', { toolsCount: tools.length });
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      logger.debug('Handling call tool request', { toolName: request.params.name });
      
      const api = this.getApiInstance(request);
      const content = await api.callTool(
        request.params.name,
        request.params.arguments,
      );

      logger.info('Call tool request completed', { toolName: request.params.name });
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ content }, null, 2),
          },
        ],
      };
    });
  }

  async run(): Promise<void> {
    logger.info('Starting server', { mode, port, endpoint });
    
    // for mcp.so
    if (mode === "rest") {
      logger.info('Starting REST server', { port, endpoint });
      
      const transport = new RestServerTransport({
        port: Number(port),
        endpoint: endpoint,
      });
      await this.server.connect(transport);

      await transport.startServer();
      
      logger.info('REST server started successfully', { port, endpoint });
      return;
    }

    // for local mcp server
    logger.info('Starting stdio server');
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    
    logger.info('Stdio server started successfully');
  }
}

const server = new AI302Server();
server.run().catch((error) => {
  logger.error('Server failed to start', { error: error.message });
  console.error(error);
  process.exit(1);
});
