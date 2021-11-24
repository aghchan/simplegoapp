package http

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/aghchan/simplegoapp/pkg/logger"
	"github.com/gorilla/schema"
	"github.com/gorilla/websocket"
)

var (
	ErrExpectedSocketClose = errors.New("expected socket close")
	Verbs                  = map[string]bool{
		http.MethodGet:    true,
		http.MethodPut:    true,
		http.MethodPost:   true,
		http.MethodDelete: true,
	}

	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}
	expectedSocketCloseErrs = []int{websocket.CloseNoStatusReceived}
)

type ResponseWriter = http.ResponseWriter
type Request = http.Request

type Controller struct {
	Logger logger.Logger
}

func (this Controller) Upgrade(w http.ResponseWriter, req *http.Request) (*websocket.Conn, chan []byte, error) {
	conn, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		this.Logger.Error(
			"upgrading to socket",
			"error", err,
			"path", req.RequestURI,
		)

		return nil, nil, err
	}

	out := make(chan []byte, 1)
	go func(conn *websocket.Conn, out <-chan []byte) {
		writeSocket(conn, out)
	}(conn, out)

	return conn, out, nil
}

func (this Controller) ReadSocket(conn *websocket.Conn) ([]byte, error) {
	_, message, err := conn.ReadMessage()
	if err != nil {
		if !errors.Is(err, io.ErrUnexpectedEOF) &&
			!websocket.IsCloseError(err, expectedSocketCloseErrs...) {
			this.Logger.Error(
				"reading from socket",
				"err", err,
			)
		}

		return nil, err
	}

	return message, nil
}

func (this Controller) SendMessage(out chan []byte, message interface{}) error {
	b, err := json.Marshal(message)
	if err != nil {
		this.Logger.Error(
			"marshaling message",
			"err", err,
			"message", message,
		)

		return err
	}

	out <- b

	return nil
}

func (this Controller) ParseParams(req *Request, obj interface{}) error {
	decoder := schema.NewDecoder()
	err := decoder.Decode(obj, req.URL.Query())
	if err != nil {
		this.Logger.Error(
			"parsing query params",
			"err", err,
			"params", req.URL.Query(),
			"path", req.RequestURI,
		)

		return err
	}

	return nil
}

func (this Controller) ParseBody(req *Request, obj interface{}) error {
	err := json.NewDecoder(req.Body).Decode(obj)
	if err != nil {
		this.Logger.Error(
			"parsing payload",
			"err", err,
			"body", req.Body,
			"path", req.RequestURI,
		)

		return err
	}

	return nil
}

func (this Controller) Respond(w http.ResponseWriter, obj interface{}) {
	resp, err := json.Marshal(obj)
	if err != nil {
		this.Logger.Error(
			"marshaling response",
			"err", err,
			"response", obj,
		)
	}

	w.Header().Set("Content-Type", "application/json")

	_, err = w.Write(resp)
	if err != nil {
		this.Logger.Error(
			"writing response",
			"err", err,
			"response", resp,
		)
	}
}

func (this Controller) InternalError(w http.ResponseWriter, err error) {
	w.WriteHeader(http.StatusInternalServerError)
	resp, _ := json.Marshal(
		errorResp{
			Message: err.Error(),
		},
	)

	_, err = w.Write(resp)
	if err != nil {
		this.Logger.Error(
			"marshaling internal error response",
			"err", err,
			"response", resp,
		)
	}
}

type errorResp struct {
	Message string `json:"error"`
}

func writeSocket(conn *websocket.Conn, out <-chan []byte) {
	for {
		select {
		case msg, ok := <-out:
			if !ok {
				out = nil

				break
			}

			err := conn.WriteMessage(websocket.TextMessage, []byte(msg))
			if err != nil {
				out = nil

				break
			}
		}

		if out == nil {
			break
		}
	}
}
