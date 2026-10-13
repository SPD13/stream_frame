package main

// The installer's state and work: step 1 (find the Frame, check Developer Mode, sign in, check the Frame is ready) and step 2
// (install, update or uninstall). The page polls GET /api/state and starts the work with POST requests; every API request
// carries the random token of the page's address, so other web pages cannot drive the installer.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	releaseAPI   = "https://api.github.com/repos/SPD13/stream_frame/releases/latest"
	libraryName  = "Stream Frame"
	defaultUser  = "steamos"
	defaultHost  = "frame.local"
	neededFreeKB = 1_000_000 // Google Chrome (downloaded and unpacked on the Frame), its profile and the unpacked release
	bundleDir    = "$HOME/.cache/stream-frame-install"
	installDir   = "$HOME/.local/share/stream-frame" // SF_DATA of install.sh
)

var archiveName = regexp.MustCompile(`^stream-frame-(.+)\.tar\.gz$`)

type checkItem struct {
	ID     string   `json:"id"`
	Title  string   `json:"title"`
	Status string   `json:"status"` // idle, running, ok, fail, wait (needs the user: the password)
	Detail string   `json:"detail"`
	Help   []string `json:"help,omitempty"`
	Action string   `json:"action,omitempty"` // a button the page shows with the help: "trust-key"
}

type releaseInfo struct {
	Loading bool   `json:"loading"`
	Error   string `json:"error,omitempty"`
	Version string `json:"version,omitempty"`
	Date    string `json:"date,omitempty"`
	Size    int64  `json:"size,omitempty"`
	Local   bool   `json:"local,omitempty"` // --archive
	url     string
	digest  string
	path    string
}

type installedInfo struct {
	Known   bool   `json:"known"` // the Frame was checked
	Present bool   `json:"present"`
	Version string `json:"version,omitempty"` // none for an install from a git clone
	Running bool   `json:"running,omitempty"` // Stream Frame is open on the Frame
}

type jobLine struct {
	Text string `json:"text"`
	Kind string `json:"kind"` // step, note, warn, error
}

type jobState struct {
	Kind         string    `json:"kind"`            // install, uninstall
	Purge        bool      `json:"purge,omitempty"` // uninstall: the profile and settings go too
	Running      bool      `json:"running"`
	Failed       bool      `json:"failed"`
	Message      string    `json:"message,omitempty"`
	Warning      string    `json:"warning,omitempty"` // installed, with something left to do (the library entry)
	Progress     float64   `json:"progress"`          // 0..1 while sending, -1 otherwise
	ProgressText string    `json:"progressText,omitempty"`
	Lines        []jobLine `json:"lines"`
}

type appState struct {
	Title       string        `json:"title"`
	Address     string        `json:"address"`
	Frames      []foundFrame  `json:"frames"`
	Discovering bool          `json:"discovering"`
	Checking    bool          `json:"checking"`
	Checks      []checkItem   `json:"checks"`
	Ready       bool          `json:"ready"`
	Installed   installedInfo `json:"installed"`
	Latest      releaseInfo   `json:"latest"`
	Job         *jobState     `json:"job"`
	LibraryName string        `json:"libraryName"`
	Version     string        `json:"version"`
	LogPath     string        `json:"logPath"`
	Browser     bool          `json:"browser"`
}

type app struct {
	token string

	mu       sync.Mutex
	state    appState
	conn     *frameConnection
	user     string
	ip       string
	keyName  string
	password string
	busy     bool

	lastPoll atomic.Int64
	quit     chan struct{}
	quitOnce sync.Once
}

func newApp(token, archive string) *app {
	a := &app{token: token, quit: make(chan struct{})}
	a.state = appState{Title: appTitle, LibraryName: libraryName, Version: version, LogPath: logPath, Checks: freshChecks(), Latest: releaseInfo{Loading: true}}
	if archive != "" {
		a.state.Latest = localRelease(archive)
	}
	return a
}

func freshChecks() []checkItem {
	return []checkItem{
		{ID: "find", Title: "Frame found on the network", Status: "idle"},
		{ID: "devmode", Title: "Developer Mode is on", Status: "idle"},
		{ID: "login", Title: "Signed in to the Frame", Status: "idle"},
		{ID: "ready", Title: "Frame ready for Stream Frame", Status: "idle"},
	}
}

func (a *app) update(change func(*appState)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	change(&a.state)
}

func (a *app) setCheck(id, status, detail string, help ...string) {
	logf("check %s: %s: %s", id, status, detail)
	a.update(func(s *appState) {
		for i := range s.Checks {
			if s.Checks[i].ID == id {
				s.Checks[i] = checkItem{ID: id, Title: s.Checks[i].Title, Status: status, Detail: detail, Help: help}
			}
		}
	})
}

// start: look up the latest release, find the Frames on the network, and check the likely one without a password (an ssh
// key may be enough)
func (a *app) start() {
	if !a.state.Latest.Local {
		go a.fetchLatest()
	}
	a.update(func(s *appState) { s.Discovering = true })
	frames := discoverFrames(2 * time.Second)
	logf("found on the network: %v", frames)
	last := loadSettings().LastAddress
	address := last
	if address == "" || (len(frames) > 0 && !matchesFrame(last, frames)) {
		address = defaultHost
		if len(frames) > 0 {
			address = frameAddress(frames[0])
		}
	}
	a.update(func(s *appState) {
		s.Discovering = false
		s.Frames = frames
		if s.Address == "" {
			s.Address = address
		}
	})
	a.mu.Lock()
	address = a.state.Address
	a.mu.Unlock()
	a.runChecks(address, "")
}

func frameAddress(f foundFrame) string {
	if f.Host != "" {
		return f.Host
	}
	return f.Address
}

func matchesFrame(address string, frames []foundFrame) bool {
	_, host := splitUser(address)
	for _, f := range frames {
		if strings.EqualFold(host, f.Host) || host == f.Address {
			return true
		}
	}
	return false
}

func splitUser(address string) (user, host string) {
	address = strings.TrimSpace(address)
	if i := strings.LastIndex(address, "@"); i >= 0 {
		return address[:i], address[i+1:]
	}
	return defaultUser, address
}

// runChecks is step 1. A password of "" tries the user's ssh keys only, and asks for the password when they are refused.
func (a *app) runChecks(address, password string) {
	a.mu.Lock()
	if a.busy {
		a.mu.Unlock()
		return
	}
	a.busy = true
	if a.conn != nil {
		a.conn.close()
		a.conn = nil
	}
	a.state.Checking = true
	a.state.Ready = false
	a.state.Address = strings.TrimSpace(address)
	a.state.Checks = freshChecks()
	a.state.Installed = installedInfo{}
	if a.state.Job != nil && !a.state.Job.Running {
		a.state.Job = nil
	}
	frames := a.state.Frames
	a.mu.Unlock()
	defer a.update(func(s *appState) { s.Checking = false })
	defer func() { a.mu.Lock(); a.busy = false; a.mu.Unlock() }()

	user, host := splitUser(address)
	if host == "" {
		a.setCheck("find", "fail", "No address", "Type the Frame's name (frame.local) or its IP address above, then select Connect.")
		return
	}

	// 1. The Frame on the network
	a.setCheck("find", "running", "Looking for "+host+"...")
	ip := ""
	if parsed := net.ParseIP(host); parsed != nil {
		ip = parsed.String()
		a.setCheck("find", "ok", "IP address "+ip)
	} else {
		for _, f := range frames {
			if strings.EqualFold(f.Host, host) || strings.EqualFold(f.Name, host) {
				ip = f.Address
			}
		}
		if ip == "" {
			if found, ok := resolveHost(host, 3*time.Second); ok {
				ip = found
			}
		}
		if ip == "" {
			// The list may have been made before the Frame woke up: look again
			for _, f := range discoverFrames(2 * time.Second) {
				if strings.EqualFold(f.Host, host) || strings.EqualFold(f.Name, host) {
					ip = f.Address
				}
			}
		}
		if ip == "" {
			a.setCheck("find", "fail", host+" is not found on the network",
				"Put the headset on so it is awake: it leaves the network when it sleeps.",
				"The Frame and this computer must be on the same network (the same Wi-Fi or router). A guest network often keeps devices apart.",
				"Developer Mode must be on: on the Frame, **Settings > System > Enable Developer Mode**.",
				"Or type the Frame's IP address above, shown on the Frame in **Settings > Network** (select the network), for example 192.168.1.42. Then select **Connect**.")
			return
		}
		a.setCheck("find", "ok", fmt.Sprintf("%s (%s)", host, ip))
	}

	// 2. Developer Mode: the Frame accepts ssh connections
	a.setCheck("devmode", "running", "Connecting to "+ip+"...")
	probe, err := net.DialTimeout("tcp", net.JoinHostPort(ip, "22"), 8*time.Second)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "refused") {
			a.setCheck("devmode", "fail", "The Frame does not accept connections",
				"Turn Developer Mode on: on the Frame, **Settings > System > Enable Developer Mode**.",
				"Then, in the **Developer** section that appears, choose **Set User Password** and pick a password.",
				"If "+ip+" is not the Frame's address, type the right one above.")
		} else {
			a.setCheck("devmode", "fail", "No answer from "+ip,
				"Put the headset on so it is awake: it leaves the network when it sleeps.",
				"Check that "+ip+" is the Frame's address (on the Frame: **Settings > Network**, select the network).",
				"Some networks keep devices apart (guest Wi-Fi, \"client isolation\"): use the main network.")
		}
		return
	}
	probe.Close()
	a.setCheck("devmode", "ok", "ssh is open on "+ip)

	// 3. Sign in
	a.setCheck("login", "running", "Signing in as "+user+"...")
	keyName := strings.ToLower(host)
	conn, err := dialFrame(user, ip, keyName, password)
	if err != nil {
		var changed *errHostKeyChanged
		switch {
		case errors.As(err, &changed):
			a.update(func(s *appState) {
				for i := range s.Checks {
					if s.Checks[i].ID == "login" {
						s.Checks[i].Status = "fail"
						s.Checks[i].Detail = "The Frame's identity has changed"
						s.Checks[i].Help = []string{
							"The Frame does not have the security key it had when this computer last connected to it. This is expected after the Frame was reset or reinstalled.",
							"If you did not reset it, check that the address is really your Frame's. Otherwise, trust its new key.",
						}
						s.Checks[i].Action = "trust-key"
					}
				}
			})
		case strings.Contains(err.Error(), "unable to authenticate") && password == "":
			a.setCheck("login", "wait", "Type the Frame's password, then select Connect",
				"The password is the one set on the Frame in Developer Mode: **Settings > Developer > Set User Password**. Set one there if you have not yet.")
		case strings.Contains(err.Error(), "unable to authenticate"):
			a.setCheck("login", "fail", "The password was refused",
				"Type the password set on the Frame in **Settings > Developer > Set User Password** (it is case sensitive).",
				"Forgot it? Set a new one there, then select **Connect** again.")
		default:
			a.setCheck("login", "fail", "Cannot sign in: "+err.Error(),
				"Put the headset on so it stays awake, then select **Connect** again.")
		}
		return
	}
	a.mu.Lock()
	a.conn, a.user, a.ip, a.keyName, a.password = conn, user, ip, keyName, password
	a.mu.Unlock()
	updateSettings(func(s *settings) { s.LastAddress = address })
	a.setCheck("login", "ok", "Signed in as "+user)

	// 4. Ready: a Steam Frame, Steam running, Stream Frame closed, room for Chrome
	a.checkReady(conn)
}

func (a *app) checkReady(conn *frameConnection) {
	a.setCheck("ready", "running", "Checking the Frame...")
	script := `echo "arch=$(uname -m)"
if pgrep -x steam > /dev/null; then echo steam=1; else echo steam=0; fi
echo "free=$(df -Pk "$HOME" | awk 'NR==2 {print $4}')"
if command -v python3 > /dev/null; then echo python=1; else echo python=0; fi
d="` + installDir + `"
if [ -x "$d/bin/stream-frame" ]; then echo installed=1; else echo installed=0; fi
if [ -f "$d/VERSION" ]; then echo "version=$(head -c 64 "$d/VERSION")"; fi
if pgrep -f -- "--user-data-dir=$d/profile" > /dev/null; then echo running=1; else echo running=0; fi
`
	out, err := conn.output("sh -s", strings.NewReader(script))
	if err != nil {
		a.setCheck("ready", "fail", "Cannot check the Frame: "+err.Error(), "Put the headset on so it stays awake, then select **Check again**.")
		return
	}
	values := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if key, value, ok := strings.Cut(strings.TrimSpace(line), "="); ok {
			values[key] = value
		}
	}
	free, _ := strconv.ParseInt(values["free"], 10, 64)
	installed := installedInfo{Known: true, Present: values["installed"] == "1", Version: values["version"], Running: values["running"] == "1"}
	a.update(func(s *appState) { s.Installed = installed })
	switch {
	case values["arch"] != "aarch64":
		a.setCheck("ready", "fail", "This is not a Steam Frame (a "+values["arch"]+" computer)", "Check the address: it must be the Frame's.")
	case values["python"] != "1":
		a.setCheck("ready", "fail", "Python is missing on this device", "SteamOS on the Frame includes it: check that the address is the Frame's.")
	case values["steam"] != "1":
		a.setCheck("ready", "fail", "Steam is not running on the Frame",
			"Put the headset on so it starts in its normal mode (Steam starts with it), then select **Check again**.")
	case installed.Running:
		// install.sh and uninstall.sh stop while it runs: its Chrome would overwrite the profile they change
		a.setCheck("ready", "fail", "Stream Frame is open on the Frame",
			"Close it: in the Steam library, select **Stream Frame**, then **Stop**. Then select **Check again**.")
	case free < neededFreeKB:
		a.setCheck("ready", "fail", fmt.Sprintf("Not enough free space: %s free, %s needed", formatMB(free*1024), formatMB(neededFreeKB*1024)),
			"Uninstall a game or delete files on the Frame, then select **Check again**.")
	default:
		a.setCheck("ready", "ok", fmt.Sprintf("Steam is running, %s free", formatSpace(free*1024)))
		a.update(func(s *appState) { s.Ready = true })
	}
}

func formatSpace(bytes int64) string {
	if bytes >= 10e9 {
		return fmt.Sprintf("%.0f GB", float64(bytes)/1e9)
	}
	return fmt.Sprintf("%.1f GB", float64(bytes)/1e9)
}

// fetchLatest reads the latest release on GitHub: its version and the .tar.gz of Stream Frame
func (a *app) fetchLatest() {
	a.update(func(s *appState) { s.Latest = releaseInfo{Loading: true} })
	info := func() releaseInfo {
		request, _ := http.NewRequest("GET", releaseAPI, nil)
		request.Header.Set("Accept", "application/vnd.github+json")
		request.Header.Set("User-Agent", "stream-frame-installer")
		client := &http.Client{Timeout: 20 * time.Second}
		response, err := client.Do(request)
		if err != nil {
			return releaseInfo{Error: "Cannot reach GitHub to find the latest version. Check this computer's internet connection."}
		}
		defer response.Body.Close()
		if response.StatusCode == 404 {
			return releaseInfo{Error: "No Stream Frame release is published on GitHub yet."}
		}
		if response.StatusCode != 200 {
			return releaseInfo{Error: fmt.Sprintf("GitHub did not give the latest version (%s). Try again in a few minutes.", response.Status)}
		}
		var release struct {
			PublishedAt time.Time `json:"published_at"`
			Assets      []struct {
				Name   string `json:"name"`
				Size   int64  `json:"size"`
				URL    string `json:"browser_download_url"`
				Digest string `json:"digest"`
			} `json:"assets"`
		}
		if err := json.NewDecoder(response.Body).Decode(&release); err != nil {
			return releaseInfo{Error: "GitHub's answer could not be read: " + err.Error()}
		}
		for _, asset := range release.Assets {
			if m := archiveName.FindStringSubmatch(asset.Name); m != nil {
				return releaseInfo{Version: m[1], Date: release.PublishedAt.Local().Format("2 January 2006"), Size: asset.Size, url: asset.URL, digest: asset.Digest}
			}
		}
		return releaseInfo{Error: "The latest release on GitHub has no Stream Frame archive (stream-frame-<version>.tar.gz)."}
	}()
	logf("latest release: %s %s", info.Version, info.Error)
	a.update(func(s *appState) { s.Latest = info })
}

func localRelease(path string) releaseInfo {
	stat, err := os.Stat(path)
	if err != nil {
		return releaseInfo{Error: "Cannot open " + path + ": " + err.Error()}
	}
	version := filepath.Base(path)
	if m := archiveName.FindStringSubmatch(version); m != nil {
		version = m[1]
	}
	return releaseInfo{Version: version, Date: stat.ModTime().Format("2 January 2006"), Size: stat.Size(), Local: true, path: path}
}

// connection gives the open connection, signing in again (same password) when the Frame dropped it, for instance after a sleep
func (a *app) connection() (*frameConnection, error) {
	a.mu.Lock()
	conn, user, ip, keyName, password := a.conn, a.user, a.ip, a.keyName, a.password
	a.mu.Unlock()
	if conn != nil && conn.alive() {
		return conn, nil
	}
	if ip == "" {
		return nil, errors.New("not connected")
	}
	conn, err := dialFrame(user, ip, keyName, password)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	a.conn = conn
	a.mu.Unlock()
	return conn, nil
}

// beginJob marks the installer busy with a job, or says why it cannot start
func (a *app) beginJob(kind string) (*jobState, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.busy {
		return nil, errors.New("busy")
	}
	if !a.state.Ready {
		return nil, errors.New("the Frame is not ready: finish step 1")
	}
	a.busy = true
	job := &jobState{Kind: kind, Running: true, Progress: -1}
	a.state.Job = job
	return job, nil
}

func (a *app) endJob(job *jobState, failure string) {
	a.update(func(s *appState) {
		job.Running = false
		job.Progress = -1
		job.ProgressText = ""
		logf("%s finished: %s", job.Kind, failure)
		if failure != "" {
			job.Failed = true
			job.Message = failure
		}
	})
	a.mu.Lock()
	a.busy = false
	a.mu.Unlock()
	// What is on the Frame now
	if conn, err := a.connection(); err == nil {
		a.checkReady(conn)
	}
}

func (a *app) addLine(job *jobState, text string, isError bool) {
	if strings.TrimSpace(text) == "" {
		return
	}
	// The scripts stop with "install.sh: <why>" (or "uninstall.sh: ") and warn with "WARNING: "; the tools they run (curl's
	// progress, steam-shortcut.py) report on the error output too, so that alone does not make a line an error
	line := jobLine{Text: strings.TrimSpace(text), Kind: "note"}
	switch {
	case strings.HasPrefix(text, "==> "):
		line = jobLine{Text: strings.TrimPrefix(text, "==> "), Kind: "step"}
	case strings.HasPrefix(text, "install.sh: ") || strings.HasPrefix(text, "uninstall.sh: "):
		line.Kind = "error"
		line.Text = strings.TrimPrefix(strings.TrimPrefix(line.Text, "install.sh: "), "uninstall.sh: ")
	case strings.HasPrefix(line.Text, "WARNING: "):
		line.Kind = "warn"
		line.Text = strings.TrimPrefix(line.Text, "WARNING: ")
	case isError && (strings.Contains(text, "Error") || strings.Contains(text, "Traceback")):
		line.Kind = "error"
	}
	logf("%s %s: %s", job.Kind, line.Kind, line.Text)
	a.update(func(s *appState) { job.Lines = append(job.Lines, line) })
}

func lostConnectionMessage(err error) string {
	return "The connection to the Frame was lost (" + err.Error() + "). Put the headset on so it stays awake, then install again: it is always safe."
}

// install is step 2: the release archive, from GitHub or a local file, is sent through ssh straight into tar on the Frame
// (no copy on this computer), then the release's own install.sh installs it, as it does from a git clone. With updateChrome,
// it also downloads the latest Google Chrome (the .deb Chrome does not update itself).
func (a *app) install(updateChrome bool) {
	job, err := a.beginJob("install")
	if err != nil {
		return
	}
	a.mu.Lock()
	latest := a.state.Latest
	a.mu.Unlock()
	if latest.Error != "" || (latest.url == "" && latest.path == "") {
		a.endJob(job, "Stream Frame cannot be downloaded: "+latest.Error)
		return
	}
	conn, err := a.connection()
	if err != nil {
		a.endJob(job, lostConnectionMessage(err))
		return
	}

	// The archive
	a.addLine(job, "==> Downloading and sending Stream Frame ("+latest.Version+")", false)
	var source io.ReadCloser
	total := latest.Size
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if latest.Local {
		file, err := os.Open(latest.path)
		if err != nil {
			a.endJob(job, "Cannot open "+latest.path+": "+err.Error())
			return
		}
		source = file
	} else {
		request, _ := http.NewRequestWithContext(ctx, "GET", latest.url, nil)
		request.Header.Set("User-Agent", "stream-frame-installer")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			a.endJob(job, "The download from GitHub did not start: "+err.Error()+". Check this computer's internet connection, then install again.")
			return
		}
		if response.StatusCode != 200 {
			response.Body.Close()
			a.endJob(job, "The download from GitHub failed ("+response.Status+"). Try again in a few minutes.")
			return
		}
		if response.ContentLength > 0 {
			total = response.ContentLength
		}
		source = response.Body
	}
	defer source.Close()

	hash := sha256.New()
	reader := &progressReader{source: source}
	reader.lastRead.Store(time.Now().UnixNano())
	// The page's progress bar; no progress for a minute means GitHub or the Frame stalled: closing the download then ends the
	// transfer with an error
	var stalled atomic.Bool
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(300 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
			}
			if time.Since(time.Unix(0, reader.lastRead.Load())) > time.Minute {
				stalled.Store(true)
				cancel()
				source.Close()
				return
			}
			done := reader.count.Load()
			a.update(func(s *appState) {
				if total > 0 {
					job.Progress = float64(done) / float64(total)
				}
				job.ProgressText = fmt.Sprintf("%s of %s", formatMB(done), formatMB(total))
			})
		}
	}()
	unpack := `set -e; B="` + bundleDir + `"; rm -rf "$B"; mkdir -p "$B"; tar -xzf - -C "$B" --strip-components=1`
	sendErr, readErr := conn.send(unpack, io.TeeReader(reader, hash))
	close(stop)
	switch {
	case readErr != nil:
		message := "The download stopped: " + readErr.Error() + "."
		if stalled.Load() {
			message = "The download stopped: nothing arrived for a minute."
		}
		conn.output(`rm -rf "`+bundleDir+`"`, nil)
		a.endJob(job, message+" Check this computer's internet connection and that the headset is awake, then install again.")
		return
	case sendErr != nil:
		if !conn.alive() {
			a.endJob(job, lostConnectionMessage(sendErr))
		} else {
			conn.output(`rm -rf "`+bundleDir+`"`, nil)
			a.endJob(job, "Stream Frame could not be unpacked on the Frame: "+sendErr.Error())
		}
		return
	}
	if want, ok := strings.CutPrefix(latest.digest, "sha256:"); ok && !strings.EqualFold(want, hex.EncodeToString(hash.Sum(nil))) {
		conn.output(`rm -rf "`+bundleDir+`"`, nil)
		a.endJob(job, "The download was damaged (its checksum does not match). Install again.")
		return
	}
	a.update(func(s *appState) { job.Progress = -1; job.ProgressText = "" })
	a.addLine(job, "    "+formatMB(reader.count.Load())+" sent", false)

	// The release's installer, on the Frame. It copies Stream Frame (and the release's VERSION, which the next update compares
	// with) to ~/.local/share/stream-frame, so the unpacked release goes when it is done. --enable-cef-debugging: the library
	// entry is added through Steam's DevTools port, which install.sh turns on when it is closed (Steam must restart then).
	options := " --enable-cef-debugging"
	if updateChrome {
		options += " --update-chrome"
	}
	command := `B="` + bundleDir + `"; status=0; bash "$B/install.sh"` + options + ` || status=$?; rm -rf "$B"; exit $status`
	shortcut := ""
	err = conn.stream(command, nil, func(text string, isError bool) {
		switch {
		case strings.Contains(text, "enabled Steam's DevTools port"):
			shortcut = "restart"
		case strings.Contains(text, "DevTools port") && strings.Contains(text, "not reachable"), strings.Contains(text, "adding the shortcut failed"):
			if shortcut == "" {
				shortcut = "failed"
			}
		}
		a.addLine(job, text, isError)
	})
	if err != nil {
		if !conn.alive() {
			a.endJob(job, lostConnectionMessage(err))
		} else {
			a.endJob(job, "The installation on the Frame did not finish (see the messages above). Installing again is always safe.")
		}
		return
	}
	switch shortcut {
	case "restart":
		a.update(func(s *appState) {
			job.Warning = "Stream Frame is installed, but Steam must restart before it can be added to the library. Restart the headset, then select **Reinstall** here."
		})
	case "failed":
		a.update(func(s *appState) {
			job.Warning = "Stream Frame is installed, but it could not be added to the Steam library (see the messages above). Put the headset on so Steam is running, then select **Reinstall**."
		})
	}
	a.endJob(job, "")
}

// uninstall runs the uninstall.sh that install.sh left on the Frame: it removes Stream Frame, its Chrome (the .deb one, kept
// with the rest), its library entry and desktop entry; with purge, the profile (logins, tiles, button mapping) and settings too
func (a *app) uninstall(purge bool) {
	job, err := a.beginJob("uninstall")
	if err != nil {
		return
	}
	a.update(func(s *appState) { job.Purge = purge })
	conn, err := a.connection()
	if err != nil {
		a.endJob(job, lostConnectionMessage(err))
		return
	}
	a.addLine(job, "==> Removing Stream Frame from the Frame", false)
	command := `U="` + installDir + `/uninstall.sh"; [ -f "$U" ] || { echo "uninstall.sh: the uninstaller is missing in ` + installDir + `" >&2; exit 1; }; bash "$U"`
	if purge {
		command += " --purge"
	}
	err = conn.stream(command, nil, func(text string, isError bool) { a.addLine(job, text, isError) })
	if err != nil {
		a.endJob(job, "Stream Frame could not be removed (see the messages above): "+err.Error())
		return
	}
	a.endJob(job, "")
}

// trustNewKey forgets the Frame's old host key, then signs in again
func (a *app) trustNewKey(password string) {
	a.mu.Lock()
	address := a.state.Address
	a.mu.Unlock()
	_, host := splitUser(address)
	updateSettings(func(s *settings) { delete(s.HostKeys, strings.ToLower(host)) })
	a.runChecks(address, password)
}

type progressReader struct {
	source   io.Reader
	count    atomic.Int64
	lastRead atomic.Int64
}

func (r *progressReader) Read(p []byte) (int, error) {
	n, err := r.source.Read(p)
	if n > 0 {
		r.count.Add(int64(n))
		r.lastRead.Store(time.Now().UnixNano())
	}
	return n, err
}

// The page's API

type requestBody struct {
	Address      string `json:"address"`
	Password     string `json:"password"`
	Purge        bool   `json:"purge"`
	UpdateChrome bool   `json:"updateChrome"`
}

func (a *app) routes(mux *http.ServeMux) {
	handle := func(path string, method string, f func(w http.ResponseWriter, r *http.Request)) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != method || r.Header.Get("X-Token") != a.token {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			f(w, r)
		})
	}
	decode := func(r *http.Request) (requestBody, error) {
		var b requestBody
		err := json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&b)
		return b, err
	}
	handle("/api/state", "GET", func(w http.ResponseWriter, r *http.Request) {
		a.lastPoll.Store(time.Now().UnixNano())
		a.mu.Lock()
		data, _ := json.Marshal(a.state)
		a.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(data)
	})
	handle("/api/connect", "POST", func(w http.ResponseWriter, r *http.Request) {
		b, err := decode(r)
		if err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		go a.runChecks(b.Address, b.Password)
		w.WriteHeader(http.StatusNoContent)
	})
	handle("/api/trust-key", "POST", func(w http.ResponseWriter, r *http.Request) {
		b, _ := decode(r)
		go a.trustNewKey(b.Password)
		w.WriteHeader(http.StatusNoContent)
	})
	handle("/api/discover", "POST", func(w http.ResponseWriter, r *http.Request) {
		go func() {
			a.update(func(s *appState) { s.Discovering = true })
			frames := discoverFrames(2 * time.Second)
			a.update(func(s *appState) { s.Discovering = false; s.Frames = frames })
		}()
		w.WriteHeader(http.StatusNoContent)
	})
	handle("/api/latest", "POST", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		local := a.state.Latest.Local
		a.mu.Unlock()
		if !local {
			go a.fetchLatest()
		}
		w.WriteHeader(http.StatusNoContent)
	})
	handle("/api/install", "POST", func(w http.ResponseWriter, r *http.Request) {
		b, _ := decode(r)
		go a.install(b.UpdateChrome)
		w.WriteHeader(http.StatusNoContent)
	})
	handle("/api/uninstall", "POST", func(w http.ResponseWriter, r *http.Request) {
		b, _ := decode(r)
		go a.uninstall(b.Purge)
		w.WriteHeader(http.StatusNoContent)
	})
	// Only the page's own links: a page must not be able to open anything else
	links := map[string]bool{"https://github.com/SPD13/stream_frame": true, "http://spd13.us/": true, "http://spd13.us": true}
	handle("/api/open", "POST", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			URL string `json:"url"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&b) != nil || !links[b.URL] {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		openBrowser(b.URL)
		w.WriteHeader(http.StatusNoContent)
	})
	handle("/api/quit", "POST", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
		a.quitOnce.Do(func() { close(a.quit) })
	})
}

// waitForPageClosed (browser only): returns when Quit is pressed, or when the page stopped asking for the state (closed tab)
// while no job runs
func (a *app) waitForPageClosed(ctx context.Context) {
	a.update(func(s *appState) { s.Browser = true })
	opened := time.Now()
	for {
		select {
		case <-a.quit:
			return
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
		a.mu.Lock()
		busy := a.busy
		a.mu.Unlock()
		last := a.lastPoll.Load()
		if busy {
			continue
		}
		if last == 0 && time.Since(opened) > 30*time.Minute {
			return
		}
		if last != 0 && time.Since(time.Unix(0, last)) > 20*time.Second {
			return
		}
	}
}

func (a *app) shutdown() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.conn != nil {
		a.conn.close()
	}
}
