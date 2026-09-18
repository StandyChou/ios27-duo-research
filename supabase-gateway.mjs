const PUBLIC_TASK_COLUMNS = "task_id,status,owner_label,updated_at";

function throwIfError(result) {
  if (result.error) throw result.error;
  return result.data;
}

export function createSupabaseGateway(client) {
  if (!client) throw new TypeError("A Supabase client is required");

  return {
    async fetchStates() {
      const result = await client.from("todo_state").select(PUBLIC_TASK_COLUMNS);
      return throwIfError(result) ?? [];
    },

    async saveState(change) {
      const payload = {
        task_id: change.task_id,
        status: change.status,
        owner_label: change.owner_label ?? "",
      };
      const result = await client
        .from("todo_state")
        .upsert(payload, { onConflict: "task_id" })
        .select(PUBLIC_TASK_COLUMNS)
        .single();
      return throwIfError(result);
    },

    subscribe(handler, onStatus = () => {}) {
      let active = true;
      let readySettled = false;
      let resolveReady;
      let rejectReady;
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const handleStatus = (status) => {
        if (!active) return;
        onStatus(status);
        if (status === "SUBSCRIBED" && !readySettled) {
          readySettled = true;
          resolveReady();
        } else if (["TIMED_OUT", "CHANNEL_ERROR", "CLOSED"].includes(status) && !readySettled) {
          readySettled = true;
          rejectReady(new Error(`Realtime subscription failed: ${status}`));
        }
      };
      const channel = client
        .channel("todo-state")
        .on("postgres_changes", { event: "*", schema: "public", table: "todo_state" }, (payload) => {
          if (active && payload.new?.task_id) handler(payload.new);
        })
        .subscribe(handleStatus);

      return {
        ready,
        unsubscribe() {
          if (!active) return;
          active = false;
          client.removeChannel(channel);
        },
      };
    },

    async signIn(email, redirectUrl) {
      const result = await client.auth.signInWithOtp({
        email: String(email).trim().toLocaleLowerCase("en-US"),
        options: { emailRedirectTo: redirectUrl },
      });
      throwIfError(result);
    },

    async getSession() {
      const result = await client.auth.getSession();
      return throwIfError(result)?.session ?? null;
    },

    async signOut() {
      throwIfError(await client.auth.signOut());
    },

    onAuthStateChange(handler) {
      let active = true;
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        if (active) handler(session);
      });
      return () => {
        if (!active) return;
        active = false;
        data.subscription.unsubscribe();
      };
    },

    async fetchProfile(email) {
      const result = await client
        .from("workspace_members")
        .select("display_name,role,active")
        .eq("email", String(email).trim().toLocaleLowerCase("en-US"))
        .maybeSingle();
      return throwIfError(result);
    },

    async fetchNote(taskId) {
      const result = await client
        .from("todo_notes")
        .select("task_id,note,updated_at")
        .eq("task_id", taskId)
        .maybeSingle();
      return throwIfError(result);
    },

    async saveNote({ task_id, note, email }) {
      const payload = {
        task_id,
        note: String(note ?? "").slice(0, 1000),
        updated_by_email: String(email).trim().toLocaleLowerCase("en-US"),
      };
      const result = await client
        .from("todo_notes")
        .upsert(payload, { onConflict: "task_id" })
        .select("task_id,note,updated_at")
        .single();
      return throwIfError(result);
    },
  };
}
