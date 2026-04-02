import type { HostDocumentDescriptor, } from "@philo/core";
import { StatusBar, } from "expo-status-bar";
import React from "react";
import {
  AppState,
  type AppStateStatus,
  Linking,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { EditorWebView, } from "./src/components/EditorWebView";
import { useMountEffect, } from "./src/hooks/useMountEffect";
import {
  clearMobileSyncSession,
  consumeMobileSyncAuthCallback,
  createMobileSyncStatusSnapshot,
  describeMobileSyncSession,
  formatMobileSyncError,
  formatMobileSyncTimestamp,
  getMobileSyncCapability,
  listCachedDocuments,
  loadMobileDocument,
  loadMobileSyncSettings,
  type MobileSyncSettings,
  openOrCreatePage,
  openOrCreateTodayNote,
  requestMobileSyncMagicLink,
  resolveMobileAssetUrl,
  saveMobileDocument,
  syncMobileNow,
  updateMobileSyncSettings,
} from "./src/services/sync";

const TABS = [
  { key: "today", label: "Today", },
  { key: "search", label: "Search", },
  { key: "settings", label: "Settings", },
] as const;

type TabKey = (typeof TABS)[number]["key"];

type SyncCapability = Awaited<ReturnType<typeof getMobileSyncCapability>>;

function getTodayDate() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1,).padStart(2, "0",),
    String(now.getDate(),).padStart(2, "0",),
  ].join("-",);
}

function matchesSearch(document: HostDocumentDescriptor, query: string,) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;

  return (
    document.title.toLowerCase().includes(normalized,)
    || document.path.toLowerCase().includes(normalized,)
    || document.content.toLowerCase().includes(normalized,)
  );
}

function SyncBadge(
  { syncing, status, }: { syncing: boolean; status: ReturnType<typeof createMobileSyncStatusSnapshot>; },
) {
  return (
    <View style={[styles.syncBadge, syncing ? styles.syncBadgeBusy : null,]}>
      <Text style={styles.syncBadgeText}>{syncing ? "Syncing" : status.state}</Text>
    </View>
  );
}

export default function App() {
  const [activeTab, setActiveTab,] = React.useState<TabKey>("today",);
  const [activeDocument, setActiveDocument,] = React.useState<HostDocumentDescriptor | null>(null,);
  const [documents, setDocuments,] = React.useState<HostDocumentDescriptor[]>([],);
  const [loading, setLoading,] = React.useState(true,);
  const [notice, setNotice,] = React.useState("",);
  const [settings, setSettings,] = React.useState<MobileSyncSettings>({
    syncDeviceId: "",
    syncEmail: "",
    syncEnabled: false,
    syncError: "",
    syncLastSyncedAt: "",
  },);
  const [capability, setCapability,] = React.useState<SyncCapability>({
    authenticated: false,
    configured: false,
    enabled: false,
    hasPendingError: false,
    status: createMobileSyncStatusSnapshot({
      syncDeviceId: "",
      syncEmail: "",
      syncEnabled: false,
      syncError: "",
      syncLastSyncedAt: "",
    },),
  },);
  const [draftEmail, setDraftEmail,] = React.useState("",);
  const [searchQuery, setSearchQuery,] = React.useState("",);
  const [syncing, setSyncing,] = React.useState(false,);

  const deferredSearchQuery = React.useDeferredValue(searchQuery,);
  const syncStatus = createMobileSyncStatusSnapshot(settings, syncing,);
  const todayDate = getTodayDate();
  const filteredDocuments = documents.filter((document,) => matchesSearch(document, deferredSearchQuery,));
  const todayDocument = documents.find((document,) => (
    document.kind === "daily_note" && document.referenceDate === todayDate
  )) ?? null;

  async function refresh(sync = false,) {
    if (sync) {
      setSyncing(true,);
    }

    try {
      if (sync) {
        await syncMobileNow();
      }

      const [nextSettings, nextDocuments, nextCapability,] = await Promise.all([
        loadMobileSyncSettings(),
        listCachedDocuments(),
        getMobileSyncCapability(),
      ],);

      React.startTransition(() => {
        setSettings(nextSettings,);
        setDocuments(nextDocuments,);
        setCapability(nextCapability,);
        setDraftEmail((current,) => current.trim() || nextSettings.syncEmail);
      },);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Refresh failed.",);
    } finally {
      setLoading(false,);
      if (sync) {
        setSyncing(false,);
      }
    }
  }

  async function handleDeepLink(url: string,) {
    if (!url.startsWith("philo-mobile://sync-auth",)) {
      return;
    }

    try {
      await consumeMobileSyncAuthCallback(url,);
      setNotice("Sync connected. Pulling your notes now.",);
      await refresh(true,);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not finish mobile sync sign-in.",);
    }
  }

  useMountEffect(() => {
    let mounted = true;

    void (async () => {
      await refresh(false,);
      const initialUrl = await Linking.getInitialURL();
      if (mounted && initialUrl) {
        await handleDeepLink(initialUrl,);
      }
      if (mounted) {
        await refresh(true,);
      }
    })();

    const linkSubscription = Linking.addEventListener("url", ({ url, },) => {
      void handleDeepLink(url,);
    },);
    const appStateSubscription = AppState.addEventListener("change", (state: AppStateStatus,) => {
      if (state === "active") {
        void refresh(true,);
      }
    },);

    return () => {
      mounted = false;
      linkSubscription.remove();
      appStateSubscription.remove();
    };
  },);

  async function openDocument(document: HostDocumentDescriptor,) {
    setActiveDocument(document,);
  }

  async function openToday() {
    const document = await openOrCreateTodayNote(todayDate,);
    if (document) {
      setActiveDocument(document,);
    }
  }

  async function openPageFromQuery() {
    const title = searchQuery.trim();
    if (!title) return;
    const document = await openOrCreatePage(title,);
    if (document) {
      setActiveDocument(document,);
    }
  }

  async function handleSave(document: HostDocumentDescriptor,) {
    const result = await saveMobileDocument(document,);
    await refresh(settings.syncEnabled,);
    setActiveDocument(result.document,);
    return result;
  }

  async function sendMagicLink() {
    try {
      await requestMobileSyncMagicLink(draftEmail,);
      setNotice("Magic link sent. Open it on this iPhone to connect sync.",);
      await refresh(false,);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not send the magic link.",);
    }
  }

  async function toggleSyncEnabled() {
    await updateMobileSyncSettings({ syncEnabled: !settings.syncEnabled, },);
    await refresh(!settings.syncEnabled,);
  }

  async function signOut() {
    await clearMobileSyncSession();
    setNotice("Signed out of sync.",);
    await refresh(false,);
  }

  if (activeDocument) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.editorShell}>
          <View style={styles.editorHeader}>
            <TouchableOpacity onPress={() => setActiveDocument(null,)} style={styles.backButton}>
              <Text style={styles.backButtonText}>Back</Text>
            </TouchableOpacity>
            <View style={styles.editorHeaderCopy}>
              <Text style={styles.editorHeaderTitle}>{activeDocument.title}</Text>
              <Text style={styles.editorHeaderMeta}>{activeDocument.path}</Text>
            </View>
            <SyncBadge syncing={syncing} status={syncStatus} />
          </View>
          <View style={styles.editorCard}>
            <EditorWebView
              key={activeDocument.id}
              document={activeDocument}
              onLoadDocument={loadMobileDocument}
              onOpenNote={async (date,) => {
                const document = await openOrCreateTodayNote(date,);
                if (document) {
                  setActiveDocument(document,);
                }
              }}
              onOpenPage={async (title,) => {
                const document = await openOrCreatePage(title,);
                if (document) {
                  setActiveDocument(document,);
                }
              }}
              onResolveAssetUrl={resolveMobileAssetUrl}
              onSaveDocument={handleSave}
              onWidgetMutation={async () => {
                setNotice("Widget mutations are not wired on mobile yet.",);
                return 0;
              }}
              onWidgetQuery={async () => {
                setNotice("Widget queries are not wired on mobile yet.",);
                return [];
              }}
              syncState={syncStatus}
            />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.shell}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>Philo mobile</Text>
            <Text style={styles.title}>iPhone shell with local-cloud sync</Text>
            <Text style={styles.subtitle}>
              Daily notes and pages live in a local mirror on the device and sync through Supabase.
            </Text>
          </View>
          <SyncBadge syncing={syncing} status={syncStatus} />
        </View>

        <View style={styles.heroCard}>
          <Text style={styles.heroEyebrow}>Session</Text>
          <Text style={styles.heroTitle}>{describeMobileSyncSession(settings,)}</Text>
          <Text style={styles.heroCopy}>
            {capability.configured
              ? "Open your notes from Today or Search. Sync runs on launch, foreground, and manual refresh."
              : "Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY before turning sync on."}
          </Text>
          <View style={styles.heroActions}>
            <TouchableOpacity onPress={() => void openToday()} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>{todayDocument ? "Open today" : "Create today"}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => void refresh(true,)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Sync now</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.tabBar}>
          {TABS.map((tab,) => (
            <TouchableOpacity
              key={tab.key}
              onPress={() => setActiveTab(tab.key,)}
              style={[styles.tab, activeTab === tab.key ? styles.tabActive : null,]}
            >
              <Text style={[styles.tabLabel, activeTab === tab.key ? styles.tabLabelActive : null,]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {loading ? <Text style={styles.emptyCopy}>Loading mobile cache…</Text> : null}

          {activeTab === "today" && !loading
            ? (
              <>
                <View style={styles.sectionCard}>
                  <Text style={styles.sectionEyebrow}>Today</Text>
                  <Text style={styles.sectionTitle}>{todayDate}</Text>
                  <Text style={styles.sectionCopy}>
                    {todayDocument
                      ? "Your current daily note is already in the local mirror."
                      : "No daily note is cached yet for today."}
                  </Text>
                  <TouchableOpacity onPress={() => void openToday()} style={styles.primaryButton}>
                    <Text style={styles.primaryButtonText}>{todayDocument ? "Open note" : "Create note"}</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.sectionCard}>
                  <Text style={styles.sectionEyebrow}>Recent</Text>
                  <Text style={styles.sectionTitle}>Synced notes and pages</Text>
                  {documents.length === 0
                    ? <Text style={styles.emptyCopy}>Run sync once or create a note to populate the mobile cache.</Text>
                    : (
                      documents.slice(0, 10,).map((document,) => (
                        <TouchableOpacity
                          key={document.id}
                          onPress={() => void openDocument(document,)}
                          style={styles.documentRow}
                        >
                          <View style={styles.documentCopy}>
                            <Text style={styles.documentTitle}>{document.title}</Text>
                            <Text style={styles.documentMeta}>
                              {document.kind === "daily_note" ? document.referenceDate ?? document.path : document.path}
                            </Text>
                          </View>
                          <Text style={styles.documentMeta}>
                            {document.updatedAt ? formatMobileSyncTimestamp(document.updatedAt,) : "New"}
                          </Text>
                        </TouchableOpacity>
                      ))
                    )}
                </View>
              </>
            )
            : null}

          {activeTab === "search" && !loading
            ? (
              <View style={styles.sectionCard}>
                <Text style={styles.sectionEyebrow}>Search</Text>
                <Text style={styles.sectionTitle}>Search the local mirror</Text>
                <TextInput
                  autoCapitalize="none"
                  onChangeText={setSearchQuery}
                  placeholder="Search notes or type a page title…"
                  placeholderTextColor="#897f6d"
                  style={styles.input}
                  value={searchQuery}
                />
                <View style={styles.heroActions}>
                  <TouchableOpacity onPress={() => void openPageFromQuery()} style={styles.primaryButton}>
                    <Text style={styles.primaryButtonText}>Open page</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setSearchQuery("",)} style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>Clear</Text>
                  </TouchableOpacity>
                </View>
                {filteredDocuments.length === 0
                  ? <Text style={styles.emptyCopy}>No cached documents match this search yet.</Text>
                  : (
                    filteredDocuments.map((document,) => (
                      <TouchableOpacity
                        key={document.id}
                        onPress={() => void openDocument(document,)}
                        style={styles.documentRow}
                      >
                        <View style={styles.documentCopy}>
                          <Text style={styles.documentTitle}>{document.title}</Text>
                          <Text style={styles.documentMeta}>{document.path}</Text>
                        </View>
                        <Text style={styles.kindBadge}>{document.kind === "daily_note" ? "Daily" : "Page"}</Text>
                      </TouchableOpacity>
                    ))
                  )}
              </View>
            )
            : null}

          {activeTab === "settings" && !loading
            ? (
              <>
                <View style={styles.sectionCard}>
                  <Text style={styles.sectionEyebrow}>Sync</Text>
                  <Text style={styles.sectionTitle}>Managed mobile session</Text>
                  <Text style={styles.sectionCopy}>
                    Toggle sync, send a magic link, and inspect the local-cloud session state.
                  </Text>
                  <TouchableOpacity onPress={() => void toggleSyncEnabled()} style={styles.primaryButton}>
                    <Text style={styles.primaryButtonText}>
                      {settings.syncEnabled ? "Disable sync" : "Enable sync"}
                    </Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.sectionCard}>
                  <Text style={styles.sectionEyebrow}>Auth</Text>
                  <TextInput
                    autoCapitalize="none"
                    keyboardType="email-address"
                    onChangeText={setDraftEmail}
                    placeholder="you@example.com"
                    placeholderTextColor="#897f6d"
                    style={styles.input}
                    value={draftEmail}
                  />
                  <View style={styles.heroActions}>
                    <TouchableOpacity onPress={() => void sendMagicLink()} style={styles.primaryButton}>
                      <Text style={styles.primaryButtonText}>Send magic link</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => void signOut()} style={styles.secondaryButton}>
                      <Text style={styles.secondaryButtonText}>Sign out</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={styles.sectionCard}>
                  <Text style={styles.sectionEyebrow}>State</Text>
                  <Text style={styles.stateRow}>Configured: {capability.configured ? "Yes" : "No"}</Text>
                  <Text style={styles.stateRow}>Authenticated: {capability.authenticated ? "Yes" : "No"}</Text>
                  <Text style={styles.stateRow}>
                    Last sync: {formatMobileSyncTimestamp(settings.syncLastSyncedAt,)}
                  </Text>
                  <Text style={styles.stateRow}>Error: {formatMobileSyncError(settings.syncError,)}</Text>
                </View>
              </>
            )
            : null}

          {notice || settings.syncError
            ? (
              <View style={styles.noticeCard}>
                <Text style={styles.noticeText}>{settings.syncError || notice}</Text>
              </View>
            )
            : null}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f3efe5",
  },
  shell: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 24,
    gap: 18,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
  },
  headerCopy: {
    flex: 1,
  },
  eyebrow: {
    fontSize: 12,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    color: "#7b6e56",
  },
  title: {
    fontSize: 30,
    lineHeight: 34,
    fontWeight: "700",
    color: "#1a1a14",
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: "#594f3d",
  },
  heroCard: {
    borderWidth: 1,
    borderColor: "rgba(26, 26, 20, 0.08)",
    backgroundColor: "#fffdf7",
    padding: 20,
    gap: 10,
  },
  heroEyebrow: {
    fontSize: 11,
    letterSpacing: 1.3,
    textTransform: "uppercase",
    color: "#807155",
  },
  heroTitle: {
    fontSize: 22,
    lineHeight: 26,
    fontWeight: "700",
    color: "#1a1a14",
  },
  heroCopy: {
    fontSize: 16,
    lineHeight: 24,
    color: "#514735",
  },
  heroActions: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
  },
  tabBar: {
    flexDirection: "row",
    gap: 10,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: "rgba(26, 26, 20, 0.1)",
    backgroundColor: "#efe6d4",
  },
  tabActive: {
    backgroundColor: "#1f1d17",
    borderColor: "#1f1d17",
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#463d2c",
  },
  tabLabelActive: {
    color: "#faf6ed",
  },
  content: {
    gap: 16,
    paddingBottom: 40,
  },
  sectionCard: {
    borderWidth: 1,
    borderColor: "rgba(26, 26, 20, 0.08)",
    backgroundColor: "#fffdf7",
    padding: 18,
    gap: 10,
  },
  sectionEyebrow: {
    fontSize: 11,
    letterSpacing: 1.3,
    textTransform: "uppercase",
    color: "#807155",
  },
  sectionTitle: {
    fontSize: 22,
    lineHeight: 26,
    fontWeight: "700",
    color: "#1a1a14",
  },
  sectionCopy: {
    fontSize: 15,
    lineHeight: 22,
    color: "#5a513f",
  },
  primaryButton: {
    minHeight: 46,
    paddingHorizontal: 18,
    paddingVertical: 12,
    justifyContent: "center",
    backgroundColor: "#1f1d17",
  },
  primaryButtonText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#faf6ed",
  },
  secondaryButton: {
    minHeight: 46,
    paddingHorizontal: 18,
    paddingVertical: 12,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(26, 26, 20, 0.12)",
    backgroundColor: "#efe6d4",
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#463d2c",
  },
  input: {
    minHeight: 50,
    borderWidth: 1,
    borderColor: "rgba(26, 26, 20, 0.12)",
    backgroundColor: "#f9f4ea",
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: "#1a1a14",
    fontSize: 16,
  },
  documentRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: "rgba(26, 26, 20, 0.08)",
  },
  documentCopy: {
    flex: 1,
    gap: 4,
  },
  documentTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1f1d17",
  },
  documentMeta: {
    fontSize: 12,
    color: "#776b58",
  },
  kindBadge: {
    fontSize: 12,
    fontWeight: "700",
    color: "#1d4d47",
  },
  stateRow: {
    fontSize: 14,
    lineHeight: 22,
    color: "#4d4535",
  },
  emptyCopy: {
    fontSize: 15,
    lineHeight: 22,
    color: "#6d624f",
  },
  noticeCard: {
    borderWidth: 1,
    borderColor: "rgba(125, 66, 42, 0.16)",
    backgroundColor: "#fff3eb",
    padding: 16,
  },
  noticeText: {
    fontSize: 14,
    lineHeight: 21,
    color: "#7b4123",
  },
  syncBadge: {
    minHeight: 34,
    paddingHorizontal: 12,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#dcebe8",
  },
  syncBadgeBusy: {
    backgroundColor: "#1d4d47",
  },
  syncBadgeText: {
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1.1,
    color: "#1d4d47",
  },
  editorShell: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 24,
    gap: 14,
  },
  editorHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  backButton: {
    minHeight: 40,
    paddingHorizontal: 14,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(26, 26, 20, 0.12)",
    backgroundColor: "#efe6d4",
  },
  backButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#463d2c",
  },
  editorHeaderCopy: {
    flex: 1,
  },
  editorHeaderTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1a1a14",
  },
  editorHeaderMeta: {
    fontSize: 12,
    color: "#746957",
  },
  editorCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: "rgba(26, 26, 20, 0.08)",
    backgroundColor: "#fffdf7",
    overflow: "hidden",
  },
},);
