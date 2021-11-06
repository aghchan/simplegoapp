package url

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/gorilla/schema"
)

func ParseParams(req *http.Request, obj interface{}) {
	decoder := schema.NewDecoder()
	err := decoder.Decode(obj, req.URL.Query())
	if err != nil {
		panic(err)
	}
}

func Respond(w http.ResponseWriter, obj interface{}) {
	resp, err := json.Marshal(obj)
	if err != nil {
		panic(obj)
	}

	fmt.Println("resp: ", resp)

	_, err = w.Write(resp)
	if err != nil {
		panic(err)
	}
}
