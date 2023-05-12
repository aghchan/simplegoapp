package http

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/ioutil"
	"log"
	"net/http"
	"os"
	"reflect"
	"time"

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

	httpClient = &http.Client{Timeout: 10 * time.Second}
	upgrader   = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}
	expectedSocketCloseErrs = []int{websocket.CloseNoStatusReceived}
)

type (
	ResponseWriter = http.ResponseWriter
	Request        = http.Request
)

func GET(url string, params map[string]interface{}, response interface{}) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}

	// appending to query params
	query := req.URL.Query()
	for key, value := range params {
		rValue := reflect.ValueOf(value)
		switch rValue.Type().Kind() {
		case reflect.Slice:
			for i := 0; i < rValue.Len(); i++ {
				query.Add(key, fmt.Sprintf("%v", rValue.Index(i).Interface()))
			}
		default:
			query.Add(key, fmt.Sprintf("%v", rValue.Interface()))
		}
	}

	req.URL.RawQuery = query.Encode()

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}

	defer resp.Body.Close()
	responseBody, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	err = json.Unmarshal(responseBody, response)
	if err != nil {
		return err
	}

	return nil
}

func POST(url string, body, response interface{}) error {
	jsonData, err := json.Marshal(body)
	if err != nil {
		return err
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(jsonData))
	if err != nil {
		log.Fatal(err)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}

	defer resp.Body.Close()
	responseBody, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	err = json.Unmarshal(responseBody, response)
	if err != nil {
		return err
	}

	return nil
}

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

	cors := os.Getenv("CORS_ORIGIN")
	if os.Getenv("ENV") != "PRODUCTION" {
		cors = "*"
	}
	w.Header().Set("Access-Control-Allow-Origin", cors)

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
