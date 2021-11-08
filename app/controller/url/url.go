package url

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/schema"
	"go.uber.org/zap"
)

func ParseParams(req *http.Request, obj interface{}) error {
	decoder := schema.NewDecoder()
	err := decoder.Decode(obj, req.URL.Query())
	if err != nil {
		return err
	}

	return nil
}

func ParseBody(req *http.Request, obj interface{}) error {
	err := json.NewDecoder(req.Body).Decode(obj)
	if err != nil {
		return err
	}

	return nil
}

func Respond(logger *zap.SugaredLogger, w http.ResponseWriter, obj interface{}) {
	resp, err := json.Marshal(obj)
	if err != nil {
		logger.Errorw(
			"marshaling response",
			"err", err,
		)
	}

	w.Header().Set("Content-Type", "application/json")

	_, err = w.Write(resp)
	if err != nil {
		logger.Errorw(
			"writing response",
			"err", err,
		)
	}
}

func InternalError(logger *zap.SugaredLogger, w http.ResponseWriter, err error) {
	w.WriteHeader(http.StatusInternalServerError)
	resp, _ := json.Marshal(
		errorResp{
			Message: err.Error(),
		},
	)

	_, err = w.Write(resp)
	if err != nil {
		logger.Errorw(
			"marshaling response",
			"err", err,
		)
	}
}

type errorResp struct {
	Message string `json:"error"`
}
