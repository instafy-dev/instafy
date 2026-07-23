package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/ivfreader"
)

const (
	defaultBindAddress    = "127.0.0.1:9225"
	defaultDisplay        = ":1"
	defaultGeometry       = "2560x1440"
	defaultFPS            = 30
	defaultBitrateKbps    = 3_500
	maxOfferBytes         = 256 * 1024
	maxViewers            = 8
	maxPeersPerViewer     = 2
	maxOfferAttempts      = 30
	offerRateWindow       = time.Minute
	maxPeerLifetime       = 10 * time.Minute
	maxICEServers         = 8
	maxICEURLs            = 4
	maxICEURLBytes        = 2048
	maxICECredentialBytes = 4096
	maxICEConfigBytes     = 64 * 1024
	maxViewerKeyBytes     = 64
)

type config struct {
	bindAddress string
	display     string
	geometry    string
	fps         int
	bitrateKbps int
	ffmpegPath  string
	iceServers  []webrtc.ICEServer
	requireTurn bool
}

type iceServerConfig struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

type offerRequest struct {
	Type                 webrtc.SDPType    `json:"type"`
	SDP                  string            `json:"sdp"`
	ICEServers           []iceServerConfig `json:"iceServers"`
	RelayOnly            bool              `json:"relayOnly"`
	ExpiresAtUnixSeconds int64             `json:"expiresAtUnixSeconds"`
	ViewerKey            string            `json:"viewerKey"`
}

type server struct {
	config         config
	broadcaster    *frameBroadcaster
	mu             sync.Mutex
	peers          map[*webrtc.PeerConnection]*webrtc.TrackLocalStaticSample
	peerViewers    map[*webrtc.PeerConnection]string
	pendingOffers  int
	pendingViewers map[string]int
	offerAttempts  []time.Time
}

type frameBroadcaster struct {
	config config

	mu      sync.Mutex
	tracks  map[*webrtc.TrackLocalStaticSample]struct{}
	running bool
	cancel  context.CancelFunc
}

func main() {
	if err := hardenProcess(); err != nil {
		log.Fatalf("harden WebRTC sender process: %v", err)
	}

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("invalid WebRTC sender configuration: %v", err)
	}

	broadcaster := &frameBroadcaster{
		config: cfg,
		tracks: make(map[*webrtc.TrackLocalStaticSample]struct{}),
	}
	srv := &server{
		config:         cfg,
		broadcaster:    broadcaster,
		peers:          make(map[*webrtc.PeerConnection]*webrtc.TrackLocalStaticSample),
		peerViewers:    make(map[*webrtc.PeerConnection]string),
		pendingViewers: make(map[string]int),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", srv.handleHealth)
	mux.HandleFunc("POST /offer", srv.handleOffer)

	httpServer := &http.Server{
		Addr:              cfg.bindAddress,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	log.Printf(
		"Shared Browser WebRTC sender listening on %s (display=%s geometry=%s fps=%d bitrate=%dkbps)",
		cfg.bindAddress,
		cfg.display,
		cfg.geometry,
		cfg.fps,
		cfg.bitrateKbps,
	)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func loadConfig() (config, error) {
	cfg := config{
		bindAddress: envOrDefault("INSTAFY_BROWSER_WEBRTC_BIND", defaultBindAddress),
		display:     envOrDefault("DISPLAY", defaultDisplay),
		geometry:    envOrDefault("INSTAFY_BROWSER_WEBRTC_GEOMETRY", envOrDefault("INSTAFY_VNC_GEOMETRY", defaultGeometry)),
		fps:         boundedIntEnv("INSTAFY_BROWSER_WEBRTC_FPS", defaultFPS, 1, 60),
		bitrateKbps: boundedIntEnv("INSTAFY_BROWSER_WEBRTC_BITRATE_KBPS", defaultBitrateKbps, 250, 20_000),
		ffmpegPath:  envOrDefault("INSTAFY_BROWSER_WEBRTC_FFMPEG", "ffmpeg"),
		requireTurn: strings.TrimSpace(os.Getenv("INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN")) == "1",
	}

	if !validGeometry(cfg.geometry) {
		return config{}, fmt.Errorf("INSTAFY_BROWSER_WEBRTC_GEOMETRY must be WIDTHxHEIGHT")
	}
	if raw := strings.TrimSpace(os.Getenv("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON")); raw != "" {
		if len(raw) > maxICEConfigBytes {
			return config{}, fmt.Errorf("INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON is too large")
		}
		var configured []iceServerConfig
		if err := json.Unmarshal([]byte(raw), &configured); err != nil {
			return config{}, fmt.Errorf("parse INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON: %w", err)
		}
		iceServers, err := parseICEServers(configured)
		if err != nil {
			return config{}, fmt.Errorf("parse INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON: %w", err)
		}
		cfg.iceServers = iceServers
	}

	return cfg, nil
}

func parseICEServers(configured []iceServerConfig) ([]webrtc.ICEServer, error) {
	if len(configured) > maxICEServers {
		return nil, fmt.Errorf("too many ICE servers")
	}
	parsed := make([]webrtc.ICEServer, 0, len(configured))
	for _, server := range configured {
		if len(server.URLs) == 0 || len(server.URLs) > maxICEURLs {
			return nil, fmt.Errorf("WebRTC ICE server must have 1-%d URLs", maxICEURLs)
		}
		urls := make([]string, 0, len(server.URLs))
		for _, value := range server.URLs {
			url := strings.TrimSpace(value)
			if len(url) == 0 || len(url) > maxICEURLBytes || !validICEURL(url) {
				return nil, fmt.Errorf("WebRTC ICE server URL is invalid")
			}
			urls = append(urls, url)
		}
		username := strings.TrimSpace(server.Username)
		credential := strings.TrimSpace(server.Credential)
		if len(username) > maxICECredentialBytes || len(credential) > maxICECredentialBytes {
			return nil, fmt.Errorf("WebRTC ICE credential is too large")
		}
		parsed = append(parsed, webrtc.ICEServer{
			URLs:       urls,
			Username:   username,
			Credential: credential,
		})
	}
	return parsed, nil
}

func hasAuthenticatedTURN(servers []webrtc.ICEServer) bool {
	for _, server := range servers {
		credential, credentialOK := server.Credential.(string)
		if strings.TrimSpace(server.Username) == "" || !credentialOK || strings.TrimSpace(credential) == "" {
			continue
		}
		for _, rawURL := range server.URLs {
			value := strings.ToLower(strings.TrimSpace(rawURL))
			if strings.HasPrefix(value, "turn:") || strings.HasPrefix(value, "turns:") {
				return true
			}
		}
	}
	return false
}

func validICEURL(value string) bool {
	lower := strings.ToLower(value)
	return strings.HasPrefix(lower, "stun:") ||
		strings.HasPrefix(lower, "stuns:") ||
		strings.HasPrefix(lower, "turn:") ||
		strings.HasPrefix(lower, "turns:")
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func boundedIntEnv(name string, fallback, minimum, maximum int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil {
		return fallback
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func validGeometry(value string) bool {
	widthText, heightText, ok := strings.Cut(strings.TrimSpace(value), "x")
	if !ok {
		return false
	}
	width, widthErr := strconv.Atoi(widthText)
	height, heightErr := strconv.Atoi(heightText)
	return widthErr == nil && heightErr == nil && width >= 320 && height >= 240 && width <= 8192 && height <= 8192
}

func validViewerKey(value string) bool {
	if len(value) == 0 || len(value) > maxViewerKeyBytes {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') &&
			(character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') &&
			character != '-' && character != '_' {
			return false
		}
	}
	return true
}

func (s *server) handleHealth(writer http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	peerCount := len(s.peers)
	s.mu.Unlock()

	writer.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(writer).Encode(map[string]any{
		"ok":          true,
		"activePeers": peerCount,
	})
}

func (s *server) handleOffer(writer http.ResponseWriter, request *http.Request) {
	if !s.allowOfferAttempt(time.Now()) {
		http.Error(writer, "too many WebRTC offer attempts", http.StatusTooManyRequests)
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, maxOfferBytes)
	defer request.Body.Close()

	var offer offerRequest
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&offer); err != nil {
		http.Error(writer, "invalid WebRTC offer", http.StatusBadRequest)
		return
	}
	if offer.Type != webrtc.SDPTypeOffer || strings.TrimSpace(offer.SDP) == "" {
		http.Error(writer, "expected a non-empty WebRTC offer", http.StatusBadRequest)
		return
	}
	offer.ViewerKey = strings.TrimSpace(offer.ViewerKey)
	if !validViewerKey(offer.ViewerKey) {
		http.Error(writer, "invalid WebRTC viewer identity", http.StatusBadRequest)
		return
	}
	peerExpiresAt, err := boundedOfferExpiry(offer.ExpiresAtUnixSeconds, time.Now())
	if err != nil {
		http.Error(writer, "WebRTC viewing grant expired", http.StatusUnauthorized)
		return
	}
	iceServers, err := parseICEServers(offer.ICEServers)
	if err != nil {
		http.Error(writer, "invalid WebRTC ICE configuration", http.StatusBadRequest)
		return
	}
	if s.config.requireTurn && !offer.RelayOnly {
		http.Error(writer, "relay-only WebRTC is required", http.StatusForbidden)
		return
	}
	if offer.RelayOnly && !hasAuthenticatedTURN(iceServers) {
		http.Error(writer, "relay-only WebRTC requires authenticated TURN", http.StatusBadRequest)
		return
	}

	if !s.reservePeerSlot(offer.ViewerKey) {
		http.Error(writer, "too many WebRTC viewers", http.StatusTooManyRequests)
		return
	}
	reserved := true
	defer func() {
		if reserved {
			s.releasePeerSlot(offer.ViewerKey)
		}
	}()

	peerConfiguration := webrtc.Configuration{ICEServers: iceServers}
	if offer.RelayOnly {
		peerConfiguration.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}
	peer, err := webrtc.NewPeerConnection(peerConfiguration)
	if err != nil {
		http.Error(writer, "unable to create WebRTC peer", http.StatusInternalServerError)
		return
	}

	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8},
		"shared-browser",
		"instafy",
	)
	if err != nil {
		_ = peer.Close()
		http.Error(writer, "unable to create WebRTC video track", http.StatusInternalServerError)
		return
	}

	rtpSender, err := peer.AddTrack(track)
	if err != nil {
		_ = peer.Close()
		http.Error(writer, "unable to add WebRTC video track", http.StatusInternalServerError)
		return
	}
	go drainRTCP(rtpSender)

	if err := peer.SetRemoteDescription(webrtc.SessionDescription{Type: offer.Type, SDP: offer.SDP}); err != nil {
		_ = peer.Close()
		http.Error(writer, "unable to apply WebRTC offer", http.StatusBadRequest)
		return
	}
	answer, err := peer.CreateAnswer(nil)
	if err != nil {
		_ = peer.Close()
		http.Error(writer, "unable to create WebRTC answer", http.StatusInternalServerError)
		return
	}
	gatheringComplete := webrtc.GatheringCompletePromise(peer)
	if err := peer.SetLocalDescription(answer); err != nil {
		_ = peer.Close()
		http.Error(writer, "unable to apply WebRTC answer", http.StatusInternalServerError)
		return
	}

	select {
	case <-gatheringComplete:
	case <-request.Context().Done():
		_ = peer.Close()
		return
	case <-time.After(10 * time.Second):
		_ = peer.Close()
		http.Error(writer, "WebRTC ICE gathering timed out", http.StatusGatewayTimeout)
		return
	}
	if !peerExpiresAt.After(time.Now()) {
		_ = peer.Close()
		http.Error(writer, "WebRTC viewing grant expired", http.StatusUnauthorized)
		return
	}

	s.registerReservedPeer(peer, track, offer.ViewerKey)
	reserved = false
	s.broadcaster.add(track)
	s.expirePeerAt(peer, peerExpiresAt)

	localDescription := peer.LocalDescription()
	if localDescription == nil {
		s.removePeer(peer)
		http.Error(writer, "WebRTC answer is unavailable", http.StatusInternalServerError)
		return
	}

	writer.Header().Set("content-type", "application/json")
	if err := json.NewEncoder(writer).Encode(localDescription); err != nil {
		s.removePeer(peer)
	}
}

func boundedOfferExpiry(expiresAtUnixSeconds int64, now time.Time) (time.Time, error) {
	if expiresAtUnixSeconds <= 0 {
		return time.Time{}, fmt.Errorf("missing WebRTC viewing expiry")
	}
	expiresAt := time.Unix(expiresAtUnixSeconds, 0)
	if !expiresAt.After(now) {
		return time.Time{}, fmt.Errorf("WebRTC viewing grant expired")
	}
	// The signed token is authoritative. Also retain a local ceiling so a
	// malformed direct loopback request cannot create an unexpectedly durable
	// peer even if origin policy is bypassed inside the runtime container.
	if maximum := now.Add(maxPeerLifetime); expiresAt.After(maximum) {
		expiresAt = maximum
	}
	return expiresAt, nil
}

func (s *server) allowOfferAttempt(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := now.Add(-offerRateWindow)
	kept := s.offerAttempts[:0]
	for _, attempt := range s.offerAttempts {
		if attempt.After(cutoff) {
			kept = append(kept, attempt)
		}
	}
	s.offerAttempts = kept
	if len(s.offerAttempts) >= maxOfferAttempts {
		return false
	}
	s.offerAttempts = append(s.offerAttempts, now)
	return true
}

func (s *server) viewerConnectionCountsLocked() (map[string]int, int) {
	counts := make(map[string]int)
	anonymousPeers := 0
	for peer := range s.peers {
		viewerKey := s.peerViewers[peer]
		if viewerKey == "" {
			// Conservatively preserve the limit for test/legacy in-memory state
			// that predates viewer-scoped admission.
			anonymousPeers++
			continue
		}
		counts[viewerKey]++
	}
	for viewerKey, count := range s.pendingViewers {
		if count > 0 {
			counts[viewerKey] += count
		}
	}
	return counts, anonymousPeers
}

func (s *server) reservePeerSlot(viewerKey string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pendingViewers == nil {
		s.pendingViewers = make(map[string]int)
	}
	connectionsByViewer, anonymousPeers := s.viewerConnectionCountsLocked()
	viewerConnections := connectionsByViewer[viewerKey]
	if viewerConnections >= maxPeersPerViewer {
		return false
	}
	// `maxViewers` is the distinct-viewer ceiling. A signed viewer identity
	// may temporarily own a second peer so token rotation can negotiate before
	// the old connection's close propagates back to the sender.
	if viewerConnections == 0 && len(connectionsByViewer)+anonymousPeers >= maxViewers {
		return false
	}
	s.pendingOffers++
	s.pendingViewers[viewerKey]++
	return true
}

func (s *server) releasePeerSlot(viewerKey string) {
	s.mu.Lock()
	if s.pendingOffers > 0 {
		s.pendingOffers--
	}
	if count := s.pendingViewers[viewerKey]; count <= 1 {
		delete(s.pendingViewers, viewerKey)
	} else {
		s.pendingViewers[viewerKey] = count - 1
	}
	s.mu.Unlock()
}

func (s *server) registerReservedPeer(peer *webrtc.PeerConnection, track *webrtc.TrackLocalStaticSample, viewerKey string) {
	s.mu.Lock()
	if s.pendingOffers > 0 {
		s.pendingOffers--
	}
	if count := s.pendingViewers[viewerKey]; count <= 1 {
		delete(s.pendingViewers, viewerKey)
	} else {
		s.pendingViewers[viewerKey] = count - 1
	}
	if s.peerViewers == nil {
		s.peerViewers = make(map[*webrtc.PeerConnection]string)
	}
	s.peers[peer] = track
	s.peerViewers[peer] = viewerKey
	s.mu.Unlock()

	peer.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("Shared Browser WebRTC peer state=%s", state.String())
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			s.removePeer(peer)
		}
	})
}

func (s *server) expirePeerAt(peer *webrtc.PeerConnection, expiresAt time.Time) {
	delay := time.Until(expiresAt)
	if delay <= 0 {
		s.removePeer(peer)
		return
	}
	time.AfterFunc(delay, func() {
		s.removePeer(peer)
	})
}

func (s *server) removePeer(peer *webrtc.PeerConnection) {
	s.mu.Lock()
	track, present := s.peers[peer]
	if present {
		delete(s.peers, peer)
		delete(s.peerViewers, peer)
	}
	s.mu.Unlock()
	if !present {
		return
	}
	s.broadcaster.remove(track)
	_ = peer.Close()
}

func drainRTCP(sender *webrtc.RTPSender) {
	buffer := make([]byte, 1500)
	for {
		if _, _, err := sender.Read(buffer); err != nil {
			return
		}
	}
}

func (b *frameBroadcaster) add(track *webrtc.TrackLocalStaticSample) {
	b.mu.Lock()
	b.tracks[track] = struct{}{}
	if b.running {
		b.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	b.cancel = cancel
	b.running = true
	b.mu.Unlock()
	go b.captureLoop(ctx)
}

func (b *frameBroadcaster) remove(track *webrtc.TrackLocalStaticSample) {
	b.mu.Lock()
	delete(b.tracks, track)
	if len(b.tracks) == 0 && b.cancel != nil {
		b.cancel()
	}
	b.mu.Unlock()
}

func (b *frameBroadcaster) captureLoop(ctx context.Context) {
	defer func() {
		b.mu.Lock()
		b.running = false
		b.cancel = nil
		var restartCtx context.Context
		if len(b.tracks) > 0 {
			var cancel context.CancelFunc
			restartCtx, cancel = context.WithCancel(context.Background())
			b.cancel = cancel
			b.running = true
		}
		b.mu.Unlock()
		if restartCtx != nil {
			go b.captureLoop(restartCtx)
		}
	}()

	for ctx.Err() == nil {
		if err := b.captureOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("Shared Browser WebRTC capture stopped: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func (b *frameBroadcaster) captureOnce(ctx context.Context) error {
	keyframeDistance := b.config.fps * 2
	command := exec.CommandContext(
		ctx,
		b.config.ffmpegPath,
		"-hide_banner",
		"-loglevel", "warning",
		"-f", "x11grab",
		"-draw_mouse", "0",
		"-video_size", b.config.geometry,
		"-framerate", strconv.Itoa(b.config.fps),
		"-i", b.config.display+"+0,0",
		"-an",
		"-vf", "format=yuv420p",
		"-c:v", "libvpx",
		"-deadline", "realtime",
		"-cpu-used", "8",
		"-lag-in-frames", "0",
		"-error-resilient", "1",
		"-b:v", fmt.Sprintf("%dk", b.config.bitrateKbps),
		"-g", strconv.Itoa(keyframeDistance),
		"-f", "ivf",
		"pipe:1",
	)
	command.Env = allowlistedChildEnvironment()
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		return err
	}

	reader, header, err := ivfreader.NewWith(stdout)
	if err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return fmt.Errorf("read IVF header: %w", err)
	}
	frameDuration := time.Second / time.Duration(b.config.fps)
	if header.TimebaseDenominator > 0 && header.TimebaseNumerator > 0 {
		calculated := time.Duration(float64(time.Second) * float64(header.TimebaseNumerator) / float64(header.TimebaseDenominator))
		if calculated > 0 && calculated < time.Second {
			frameDuration = calculated
		}
	}

	for ctx.Err() == nil {
		frame, _, parseErr := reader.ParseNextFrame()
		if parseErr != nil {
			if errors.Is(parseErr, io.EOF) {
				break
			}
			_ = command.Process.Kill()
			_ = command.Wait()
			return fmt.Errorf("read IVF frame: %w", parseErr)
		}
		b.broadcast(media.Sample{Data: frame, Duration: frameDuration})
	}

	if ctx.Err() != nil {
		_ = command.Process.Kill()
	}
	if err := command.Wait(); err != nil && ctx.Err() == nil {
		return err
	}
	return ctx.Err()
}

func allowlistedChildEnvironment() []string {
	keys := []string{
		"PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
		"TZ", "TMPDIR", "TMP", "TEMP", "DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR",
	}
	environment := make([]string, 0, len(keys))
	for _, key := range keys {
		if value, present := os.LookupEnv(key); present {
			environment = append(environment, key+"="+value)
		}
	}
	return environment
}

func (b *frameBroadcaster) broadcast(sample media.Sample) {
	b.mu.Lock()
	tracks := make([]*webrtc.TrackLocalStaticSample, 0, len(b.tracks))
	for track := range b.tracks {
		tracks = append(tracks, track)
	}
	b.mu.Unlock()

	for _, track := range tracks {
		if err := track.WriteSample(sample); err != nil {
			log.Printf("Shared Browser WebRTC frame write failed: %v", err)
		}
	}
}
