// ============================================================================
// CONFIGURAÇÃO DO SITE  —  é aqui que você cola os 2 dados do seu Supabase.
// Supabase > Project Settings > API Keys (ou botão "Connect").
//
//  • SUPABASE_URL  : o endereço do projeto, ex.: https://abcdefghij.supabase.co
//  • SUPABASE_KEY  : a chave PUBLISHABLE (começa com sb_publishable_...)
//                    ou, em projetos antigos, a chave "anon".
//
// ⚠ NUNCA cole aqui a chave "secret" (sb_secret_...) nem a "service_role".
//   Elas dão controle total e ficam só no arquivo robo/.env do SEU computador.
// A chave publishable pode ficar pública: quem protege os dados são as regras do banco (schema.sql).
// ============================================================================
window.ETHOS_CONFIG = {
  SUPABASE_URL: "COLE_AQUI_A_URL_DO_PROJETO",
  SUPABASE_KEY: "COLE_AQUI_A_CHAVE_PUBLISHABLE",
  SITE_URL: ""   // opcional: endereço final do site (ex.: https://seuusuario.github.io/ethos/). Vazio = detecta sozinho.
};
