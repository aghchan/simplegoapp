package gmail

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"

	"golang.org/x/oauth2"
)

// Authorize runs the one-time interactive consent flow and caches the token.
// It listens on a loopback port for the OAuth redirect, prints the consent
// URL for the user to open, and writes the token JSON to tokenPath (0600).
// The agent never calls this — a setup command does.
func Authorize(ctx context.Context, credentialsPath, tokenPath string) error {
	oauthConfig, err := oauthConfigFromFile(credentialsPath)
	if err != nil {
		return err
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	oauthConfig.RedirectURL = fmt.Sprintf("http://%s/", listener.Addr().String())

	stateBytes := make([]byte, 16)
	if _, err := rand.Read(stateBytes); err != nil {
		return err
	}
	state := hex.EncodeToString(stateBytes)

	codes := make(chan string, 1)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("state") != state {
			w.WriteHeader(http.StatusForbidden)
			fmt.Fprintln(w, "state mismatch")

			return
		}
		codes <- r.URL.Query().Get("code")
		fmt.Fprintln(w, "Authorized — you can close this tab.")
	})}
	go server.Serve(listener)
	defer server.Close()

	fmt.Printf("\nOpen this URL, sign in as the target account, and approve:\n\n  %s\n\n",
		oauthConfig.AuthCodeURL(state, oauth2.AccessTypeOffline))

	var code string
	select {
	case code = <-codes:
	case <-ctx.Done():
		return ctx.Err()
	}

	token, err := oauthConfig.Exchange(ctx, code)
	if err != nil {
		return err
	}

	raw, err := json.Marshal(token)
	if err != nil {
		return err
	}

	return os.WriteFile(tokenPath, raw, 0o600)
}
