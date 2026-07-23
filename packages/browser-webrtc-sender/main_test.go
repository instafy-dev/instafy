package main

import (
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestValidGeometry(t *testing.T) {
	t.Parallel()

	for _, value := range []string{"1280x720", "2560x1440", "320x240", "8192x8192"} {
		if !validGeometry(value) {
			t.Fatalf("expected %q to be valid", value)
		}
	}
	for _, value := range []string{"", "1280", "0x720", "1280x0", "100x100", "9000x720", "1280X720"} {
		if validGeometry(value) {
			t.Fatalf("expected %q to be invalid", value)
		}
	}
}

func TestLoadConfigParsesICEServers(t *testing.T) {
	t.Setenv("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON", `[{"urls":["turns:turn.example.test:5349"],"username":"user","credential":"secret"}]`)
	t.Setenv("INSTAFY_BROWSER_WEBRTC_GEOMETRY", "1920x1080")
	defer os.Unsetenv("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig failed: %v", err)
	}
	if len(cfg.iceServers) != 1 || len(cfg.iceServers[0].URLs) != 1 {
		t.Fatalf("unexpected ICE servers: %#v", cfg.iceServers)
	}
	if cfg.geometry != "1920x1080" {
		t.Fatalf("unexpected geometry: %s", cfg.geometry)
	}
}

func TestAllowlistedChildEnvironmentExcludesTurnAndArbitrarySecrets(t *testing.T) {
	t.Setenv("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON", `[{"credential":"turn-secret"}]`)
	t.Setenv("INSTAFY_TEST_ARBITRARY_SECRET", "must-not-leak")

	inherited := strings.Join(allowlistedChildEnvironment(), "\n")
	if strings.Contains(inherited, "turn-secret") {
		t.Fatal("ffmpeg child inherited TURN credentials")
	}
	if strings.Contains(inherited, "INSTAFY_TEST_ARBITRARY_SECRET") {
		t.Fatal("ffmpeg child inherited arbitrary runtime secret")
	}
}

func TestLoadConfigRejectsInvalidICEServerURLs(t *testing.T) {
	t.Setenv("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON", `[{"urls":["https://not-ice.test"]}]`)
	if _, err := loadConfig(); err == nil {
		t.Fatal("invalid ICE URL should fail configuration")
	}
}

func TestAuthenticatedTURNRequiresCredentialsAndAcceptsUppercaseSchemes(t *testing.T) {
	servers, err := parseICEServers([]iceServerConfig{{
		URLs:       []string{"TURNS:turn.example.test:443?transport=tcp"},
		Username:   "ephemeral",
		Credential: "derived",
	}})
	if err != nil {
		t.Fatalf("parse ICE servers: %v", err)
	}
	if !hasAuthenticatedTURN(servers) {
		t.Fatal("authenticated uppercase TURNS URL should satisfy relay-only policy")
	}

	servers[0].Credential = ""
	if hasAuthenticatedTURN(servers) {
		t.Fatal("TURN without a credential must not satisfy relay-only policy")
	}
}

func TestLoadConfigRequiresPerOfferRelayPolicyWhenConfigured(t *testing.T) {
	t.Setenv("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN", "1")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig failed: %v", err)
	}
	if !cfg.requireTurn {
		t.Fatal("sender must preserve the runtime relay-only trust boundary")
	}
}

func TestBoundedIntEnv(t *testing.T) {
	t.Setenv("INSTAFY_TEST_INT", "200")
	if got := boundedIntEnv("INSTAFY_TEST_INT", 10, 1, 100); got != 100 {
		t.Fatalf("expected upper clamp, got %d", got)
	}
	t.Setenv("INSTAFY_TEST_INT", "invalid")
	if got := boundedIntEnv("INSTAFY_TEST_INT", 10, 1, 100); got != 10 {
		t.Fatalf("expected fallback, got %d", got)
	}
}

func TestViewerKeyIsBoundedAndOpaque(t *testing.T) {
	for _, value := range []string{"3fe3b39c-173e-5c26-b908-85800d3880f1", "viewer_123"} {
		if !validViewerKey(value) {
			t.Fatalf("expected %q to be valid", value)
		}
	}
	for _, value := range []string{"", "viewer key", "viewer/key", strings.Repeat("x", maxViewerKeyBytes+1)} {
		if validViewerKey(value) {
			t.Fatalf("expected %q to be invalid", value)
		}
	}
}

func TestPeerSlotsKeepBoundedRotationHeadroomAtViewerCapacity(t *testing.T) {
	srv := &server{
		peers:          make(map[*webrtc.PeerConnection]*webrtc.TrackLocalStaticSample),
		peerViewers:    make(map[*webrtc.PeerConnection]string),
		pendingViewers: make(map[string]int),
	}
	for index := 0; index < maxViewers; index++ {
		if !srv.reservePeerSlot("viewer-" + strconv.Itoa(index)) {
			t.Fatalf("slot %d should be available", index)
		}
	}
	if srv.reservePeerSlot("new-viewer") {
		t.Fatal("pending offers must consume the distinct-viewer limit")
	}
	if !srv.reservePeerSlot("viewer-0") {
		t.Fatal("an existing viewer should retain one replacement slot")
	}
	if srv.reservePeerSlot("viewer-0") {
		t.Fatal("a viewer must not consume more than one replacement slot")
	}
	srv.releasePeerSlot("viewer-0")
	if !srv.reservePeerSlot("viewer-0") {
		t.Fatal("a released replacement slot should be reusable")
	}
}

func TestOfferAttemptsAreRateLimited(t *testing.T) {
	srv := &server{peers: make(map[*webrtc.PeerConnection]*webrtc.TrackLocalStaticSample)}
	now := time.Unix(1_000, 0)
	for index := 0; index < maxOfferAttempts; index++ {
		if !srv.allowOfferAttempt(now) {
			t.Fatalf("attempt %d should be allowed", index)
		}
	}
	if srv.allowOfferAttempt(now) {
		t.Fatal("offer attempt budget should be bounded")
	}
	if !srv.allowOfferAttempt(now.Add(offerRateWindow + time.Second)) {
		t.Fatal("expired offer attempts should not consume the budget")
	}
}

func TestOfferExpiryIsRequiredExpiredAndLocallyBounded(t *testing.T) {
	now := time.Unix(1_000, 500_000_000)
	for _, expiresAt := range []int64{0, 999, 1_000} {
		if _, err := boundedOfferExpiry(expiresAt, now); err == nil {
			t.Fatalf("expiry %d should be rejected at %s", expiresAt, now)
		}
	}

	signedExpiry := now.Add(2 * time.Minute).Unix()
	got, err := boundedOfferExpiry(signedExpiry, now)
	if err != nil {
		t.Fatalf("valid signed expiry failed: %v", err)
	}
	if !got.Equal(time.Unix(signedExpiry, 0)) {
		t.Fatalf("signed expiry changed: got %s", got)
	}

	got, err = boundedOfferExpiry(now.Add(24*time.Hour).Unix(), now)
	if err != nil {
		t.Fatalf("long signed expiry failed: %v", err)
	}
	if !got.Equal(now.Add(maxPeerLifetime)) {
		t.Fatalf("long peer lifetime was not capped: got %s", got)
	}
}

func TestPeerIsRemovedAtViewingGrantExpiry(t *testing.T) {
	peer, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create peer: %v", err)
	}
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8},
		"shared-browser",
		"instafy",
	)
	if err != nil {
		t.Fatalf("create track: %v", err)
	}
	broadcaster := &frameBroadcaster{
		tracks: map[*webrtc.TrackLocalStaticSample]struct{}{track: {}},
	}
	srv := &server{
		broadcaster: broadcaster,
		peers: map[*webrtc.PeerConnection]*webrtc.TrackLocalStaticSample{
			peer: track,
		},
	}
	srv.expirePeerAt(peer, time.Now().Add(20*time.Millisecond))

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		srv.mu.Lock()
		remaining := len(srv.peers)
		srv.mu.Unlock()
		if remaining == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("peer remained registered past its viewing grant expiry")
}
