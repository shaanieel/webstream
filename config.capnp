using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
    (name = "assets", disk = (path = "src/public", writable = false)),
    (name = "maintenance", disk = (path = ".", writable = false)),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:8789", http = (), service = "main"),
  ],
);

const mainWorker :Workerd.Worker = (
  modules = [
    (name = "entry.js", esModule = embed "entry.js"),
    (name = "src/worker/worker.js", esModule = embed "src/worker/worker.js"),
  ],
  compatibilityDate = "2025-01-15",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "ASSETS", service = "assets"),
    (name = "MAINTENANCE", service = "maintenance"),
    (name = "MAINTENANCE_MODE", fromEnvironment = "MAINTENANCE_MODE"),
    (name = "PUBLIC_BASE_URL", fromEnvironment = "PUBLIC_BASE_URL"),
    (name = "WORKER_SELF_URL", fromEnvironment = "WORKER_SELF_URL"),
    (name = "SUPABASE_URL", fromEnvironment = "SUPABASE_URL"),
    (name = "SUPABASE_ANON_KEY", fromEnvironment = "SUPABASE_ANON_KEY"),
    (name = "SUPABASE_SERVICE_KEY", fromEnvironment = "SUPABASE_SERVICE_KEY"),
    (name = "GDI_WORKER_URL", fromEnvironment = "GDI_WORKER_URL"),
    (name = "ADMIN_EMAILS", fromEnvironment = "ADMIN_EMAILS"),
    (name = "PLAYER4ME_API_TOKEN", fromEnvironment = "PLAYER4ME_API_TOKEN"),
    (name = "PLAYER4ME_BASIC_DOMAIN", fromEnvironment = "PLAYER4ME_BASIC_DOMAIN"),
    (name = "PLAYER4ME_VIP_DOMAIN", fromEnvironment = "PLAYER4ME_VIP_DOMAIN"),
    (name = "PLAYER4ME_PUBLIC_DOMAIN", fromEnvironment = "PLAYER4ME_PUBLIC_DOMAIN"),
    (name = "TMDB_API_KEY", fromEnvironment = "TMDB_API_KEY"),
    (name = "SUBSOURCE_API_KEY", fromEnvironment = "SUBSOURCE_API_KEY"),
    (name = "VIOLET_MODE", fromEnvironment = "VIOLET_MODE"),
    (name = "VIOLET_API_BASE", fromEnvironment = "VIOLET_API_BASE"),
    (name = "VIOLET_API_KEY", fromEnvironment = "VIOLET_API_KEY"),
    (name = "VIOLET_SECRET_KEY", fromEnvironment = "VIOLET_SECRET_KEY"),
    (name = "VIOLET_DEFAULT_CHANNEL", fromEnvironment = "VIOLET_DEFAULT_CHANNEL"),
    (name = "VIOLET_DEFAULT_PHONE", fromEnvironment = "VIOLET_DEFAULT_PHONE"),
    (name = "TOKO1_CALLBACK_URL", fromEnvironment = "TOKO1_CALLBACK_URL"),
    (name = "WEBSTREAM_REF_PREFIX", fromEnvironment = "WEBSTREAM_REF_PREFIX"),
    (name = "WEBSTREAM_VERIFY_VMP_CALLBACK_SIG", fromEnvironment = "WEBSTREAM_VERIFY_VMP_CALLBACK_SIG"),
    (name = "TELEGRAM_BOT_TOKEN", fromEnvironment = "TELEGRAM_BOT_TOKEN"),
    (name = "TELEGRAM_CHAT_ID", fromEnvironment = "TELEGRAM_CHAT_ID"),
  ],
);
