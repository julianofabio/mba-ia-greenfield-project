# Fase 03 — TRACKER de execução

> Estado vivo da execução autônoma da Fase 03. Atualizado a cada etapa e commitado junto.
> **Para retomar num chat novo:** "Leia `docs/phases/phase-03-videos/brief.md`, `TRACKER.md` e `progress.md` e continue a Fase 03 a partir do Próximo passo."

**Última atualização:** 2026-11-02 — fase concluída

## Próximo passo

Fase 03 concluída. Pendências do usuário: revisar a branch `feature/phase-03-videos` e integrá-la à `dev` (merge/PR) e fazer o push. Nada foi enviado ao remoto.

## Pipeline

| Etapa | Status | Artefato / commit |
|-------|--------|-------------------|
| Setup Git Flow | ✅ | `dev` local = `main` (fast-forward); branch `feature/phase-03-videos` |
| research | ✅ | `docs/decisions/technical-decisions-phase-03-videos.md` (TD-01..TD-11) — `047bbd5` |
| plan-context | ✅ | `context.md` — `a7bdf48` |
| plan-validate (1ª) | ✅ dirty, 15 issues | `validation.md` — `639fd88` |
| plan-resolve | ✅ | decisões A em todos os TDs + `library-refs.md` — `e938f5f` |
| plan-validate (2ª) | ✅ **clean** | `78c69e0` |
| plan-build | ✅ | `phase-03-videos.md` (13 SIs + Tech Specs) — `89bb8dc` |
| plan-test-specs | ✅ | `nestjs-project/specs/videos-upload.plan.md`, `videos-playback.plan.md` — `797374d` |
| Linha de base verde | ✅ | `bugfix/baseline-test-suite` → `dev` (`e79e659`) → feature (`26530f4`) |
| implement (SI-03.1..13) | ✅ 13/13 | `progress.md` |
| Fechamento (DoD + CLAUDE.md + critérios) | ✅ | DoD verde: 267 testes unit/integração, 69 e2e, tsc 0, lint 0 erros, builds ok; smoke test na stack real |

## Linha de base (antes de qualquer código da fase) — RESOLVIDA

Resultado depois do bugfix: lint 0 erros (40 warnings), `tsc` 0, `npm test` 144/144, e2e 52/52. Causas: o teste de migrations não derrubava o enum `verification_tokens_type_enum` e deixava o banco quebrado; o timeout de 5 s do Jest; e erros de lint pré-existentes.

Diagnóstico original:

- `npx tsc --noEmit`: ✅ exit 0.
- `npm test -- --runInBand`: ❌ 2 suítes / 5 testes (`auth.service.integration-spec.ts`, `migrations.integration-spec.ts`).
- `npm run test:e2e`: ❌ 3 suítes / 49 testes. Causa confirmada em `app.e2e-spec`: `Exceeded timeout of 5000 ms for a hook` no `beforeAll` que monta o `AppModule`. A leitura de `node_modules` pelo bind mount do Windows deixa o boot acima de 5 s; não é custo de type-check, porque com `isolatedModules` o tempo é o mesmo.
- `test:e2e` roda sem `--runInBand` (3 workers no mesmo banco), apesar de o `nestjs-project/CLAUDE.md` dizer o contrário.
- Lint: ❌ 150 erros e 40 warnings pré-existentes. Erros por arquivo: `test/auth.e2e-spec.ts` 48, `src/auth/auth.service.spec.ts` 45, `src/mail/mail.service.integration-spec.ts` 16, `src/channels/channels.service.spec.ts` 15, `src/auth/auth.service.integration-spec.ts` 7, `src/common/filters/domain-exception.filter.spec.ts` 7, `src/channels/channels.service.ts` 6, e mais 1–2 em outros 4 arquivos. As regras mais frequentes são `no-unsafe-member-access` (76), `no-unsafe-assignment` (41) e `unbound-method` (19).
- Atenção: um `jest` pode ficar pendurado depois do resumo final (handles abertos). Se um teste "não termina", verificar com `docker compose exec nestjs-api ps -eo pid,etimes,args | grep jest` e encerrar.

## Ambiente local (não commitado — recriar se sumir)

- Outro stack (`poc-ia`) ocupa as portas 3000 e 5432 do host. O backend sobe com um override de portas. Se o arquivo temporário sumir, recrie-o com este conteúdo e passe com `-f`:

```yaml
# nestjs-ports.override.yaml
services:
  nestjs-api:
    ports: !override
      - 3010:3000
  db:
    ports: !override
      - 5433:5432
```

  Comando (a partir de `nestjs-project/`): `docker compose -f compose.yaml -f <caminho>/nestjs-ports.override.yaml up -d`
- `nestjs-project/.env` foi criado a partir do `.env.example`, com `MAIL_FROM='"StreamTube" <noreply@streamtube.com>'` e `APP_URL=http://localhost:3010`.
- `next-frontend/.env.local` tem `API_URL=http://host.docker.internal:3010` e um `SESSION_PASSWORD` gerado.
- Imagens já baixadas: `rabbitmq:4.1.8-management`, `cgr.dev/chainguard/minio`, `cgr.dev/chainguard/minio-client` (digests no TD-03 e no SI-03.1).
- Context7: o MCP não está configurado; usar a API REST (`https://context7.com/api/v1/search?query=...` e `/api/v1/<libraryId>?type=txt&topic=...&tokens=...`).

## Decisões de execução registradas

Ver a seção "Setup and execution notes" do `progress.md`: Git Flow, Context7 via REST, subagents emulados, autonomia no resolve/build, testes rodados direto no container e imagens MinIO da Chainguard.
