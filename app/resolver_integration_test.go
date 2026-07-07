package app

import (
	"reflect"
	"testing"

	"github.com/aghchan/simplegoapp/domain/example"
	"github.com/aghchan/simplegoapp/domain/example2"
	"github.com/aghchan/simplegoapp/pkg/logger"
	"github.com/aghchan/simplegoapp/pkg/ticketmaster"
	"github.com/aghchan/simplegoapp/pkg/twilio"
)

// real graph from main.go, minus constructors that dial databases
func TestResolveProductionServiceGraph(t *testing.T) {
	configs := map[string]interface{}{
		"twilio_number":         "1234",
		"ticketmaster_api_key":  "key",
		"ticketmaster_base_url": "https://app.ticketmaster.com",
	}
	builtins := map[reflect.Type]reflect.Value{
		reflect.TypeOf(new(logger.Logger)).Elem(): reflect.ValueOf(logger.NewService()),
		reflect.TypeOf(configs):                   reflect.ValueOf(configs),
	}

	singletons, err := resolve(
		[]interface{}{
			example2.NewService, // depends on example.Service, registered after it
			twilio.NewService,
			ticketmaster.NewService,
			example.NewService,
		},
		builtins,
	)
	if err != nil {
		t.Fatalf("resolve failed: %v", err)
	}

	for _, serviceType := range []reflect.Type{
		typeOf[example.Service](),
		typeOf[example2.Service](),
		typeOf[twilio.Service](),
		typeOf[ticketmaster.Service](),
	} {
		if _, ok := singletons[serviceType]; !ok {
			t.Errorf("%v was not resolved", serviceType)
		}
	}
}
