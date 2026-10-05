import { Output, randomPassword, randomString, Services } from "~templates-utils";
import { Input } from "./meta";

export function generate(input: Input): Output {
  const services: Services = [];

  const databasePassword = randomPassword();
  const redisPassword = randomPassword();
  // Encrypts saved Git tokens and personal AI keys. Generated once; never change it.
  const folioSecret = randomString(64);

  services.push({
    type: "app",
    data: {
      serviceName: input.appServiceName,
      env: [
        `NODE_ENV=production`,
        `PORT=4870`,
        `PUBLIC_URL=https://$(PRIMARY_DOMAIN)`,
        `DATABASE_URL=postgresql://postgres:${databasePassword}@$(PROJECT_NAME)_${input.appServiceName}-db:5432/$(PROJECT_NAME)`,
        `REDIS_URL=redis://:${redisPassword}@$(PROJECT_NAME)_${input.appServiceName}-redis:6379`,
        `ASSET_BACKEND=local`,
        `FOLIO_SECRET=${folioSecret}`,
        `CURSOR_AGENT_WORKSPACE_ROOT=/app/data/assistant/workspaces`,
        `CURSOR_AGENT_STATE_DIR=/app/data/assistant/state`,
      ].join("\n"),
      source: {
        type: "image",
        image: input.appServiceImage,
      },
      domains: [
        {
          host: "$(EASYPANEL_DOMAIN)",
          port: 4870,
        },
      ],
      mounts: [
        {
          type: "volume",
          name: "data",
          mountPath: "/app/data",
        },
      ],
    },
  });

  services.push({
    type: "postgres",
    data: {
      serviceName: `${input.appServiceName}-db`,
      password: databasePassword,
    },
  });

  services.push({
    type: "redis",
    data: {
      serviceName: `${input.appServiceName}-redis`,
      password: redisPassword,
    },
  });

  return { services };
}
