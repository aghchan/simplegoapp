package app

import (
	"reflect"
	"strings"
	"testing"
)

type alpha interface{ IsAlpha() }
type alphaImpl struct{}

func (this *alphaImpl) IsAlpha() {}

type beta interface{ IsBeta() }
type betaImpl struct{ a alpha }

func (this *betaImpl) IsBeta() {}

type gamma interface{ IsGamma() }
type gammaImpl struct{ b beta }

func (this *gammaImpl) IsGamma() {}

func typeOf[T any]() reflect.Type {
	return reflect.TypeOf(new(T)).Elem()
}

func TestResolveOrderIndependentOfRegistration(t *testing.T) {
	newAlpha := func() alpha { return &alphaImpl{} }
	newBeta := func(a alpha) beta { return &betaImpl{a: a} }
	newGamma := func(b beta) gamma { return &gammaImpl{b: b} }

	// register in reverse dependency order
	singletons, err := resolve([]interface{}{newGamma, newBeta, newAlpha}, nil)
	if err != nil {
		t.Fatalf("resolve failed: %v", err)
	}

	gVal, ok := singletons[typeOf[gamma]()]
	if !ok {
		t.Fatal("gamma was not resolved")
	}

	g, ok := gVal.Interface().(*gammaImpl)
	if !ok {
		t.Fatalf("expected *gammaImpl in singleton map, got %v", gVal.Type())
	}
	if g.b == nil {
		t.Fatal("gamma was built without its beta dependency")
	}
	if g.b.(*betaImpl).a == nil {
		t.Fatal("beta was built without its alpha dependency")
	}
}

func TestResolveDeterministicInitOrder(t *testing.T) {
	// 20 runs to catch map-iteration randomness
	for run := 0; run < 20; run++ {
		var order []string
		funcs := []interface{}{
			func() alpha { order = append(order, "alpha"); return &alphaImpl{} },
			func() beta { order = append(order, "beta"); return &betaImpl{} },
			func() gamma { order = append(order, "gamma"); return &gammaImpl{} },
		}

		if _, err := resolve(funcs, nil); err != nil {
			t.Fatalf("resolve failed: %v", err)
		}

		if strings.Join(order, ",") != "alpha,beta,gamma" {
			t.Fatalf("run %d: init order not deterministic, got %v", run, order)
		}
	}
}

func TestResolvePointerReturningConstructor(t *testing.T) {
	newAlphaImpl := func() *alphaImpl { return &alphaImpl{} }
	newBeta := func(a *alphaImpl) beta { return &betaImpl{a: a} }

	singletons, err := resolve([]interface{}{newBeta, newAlphaImpl}, nil)
	if err != nil {
		t.Fatalf("resolve failed: %v", err)
	}

	aVal, ok := singletons[reflect.TypeOf(&alphaImpl{})]
	if !ok {
		t.Fatal("*alphaImpl was not resolved under its pointer type")
	}
	if _, ok := aVal.Interface().(*alphaImpl); !ok {
		t.Fatalf("expected *alphaImpl in singleton map, got %v", aVal.Type())
	}

	b := singletons[typeOf[beta]()].Interface().(*betaImpl)
	if b.a == nil {
		t.Fatal("beta was built without its pointer-typed dependency")
	}
}

func TestResolveInjectsBuiltins(t *testing.T) {
	config := map[string]interface{}{"key": "value"}
	builtins := map[reflect.Type]reflect.Value{
		reflect.TypeOf(config): reflect.ValueOf(config),
	}

	var received map[string]interface{}
	newAlpha := func(cfg map[string]interface{}) alpha {
		received = cfg
		return &alphaImpl{}
	}

	if _, err := resolve([]interface{}{newAlpha}, builtins); err != nil {
		t.Fatalf("resolve failed: %v", err)
	}
	if received == nil || received["key"] != "value" {
		t.Fatalf("builtin config not injected, got %v", received)
	}
}

func TestResolveMissingProviderNamesTypes(t *testing.T) {
	newBeta := func(a alpha) beta { return &betaImpl{a: a} }

	_, err := resolve([]interface{}{newBeta}, nil)
	if err == nil {
		t.Fatal("expected missing-provider error, got nil")
	}
	if !strings.Contains(err.Error(), "app.alpha") {
		t.Fatalf("error should name the missing type app.alpha, got: %v", err)
	}
}

func TestResolveCycleNamesMembers(t *testing.T) {
	newAlpha := func(g gamma) alpha { return &alphaImpl{} }
	newGamma := func(a alpha) gamma { return &gammaImpl{} }

	_, err := resolve([]interface{}{newAlpha, newGamma}, nil)
	if err == nil {
		t.Fatal("expected cycle error, got nil")
	}
	if !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("error should mention a cycle, got: %v", err)
	}
	if !strings.Contains(err.Error(), "app.alpha") || !strings.Contains(err.Error(), "app.gamma") {
		t.Fatalf("error should name both cycle members, got: %v", err)
	}
}

func TestResolveDuplicateProviderLastRegisteredWins(t *testing.T) {
	var calls []string
	first := func() alpha { calls = append(calls, "first"); return &alphaImpl{} }
	second := func() alpha { calls = append(calls, "second"); return &alphaImpl{} }

	singletons, err := resolve([]interface{}{first, second}, nil)
	if err != nil {
		t.Fatalf("resolve failed: %v", err)
	}

	if strings.Join(calls, ",") != "second" {
		t.Fatalf("expected only the last registered constructor to run, got calls: %v", calls)
	}
	if _, ok := singletons[typeOf[alpha]()]; !ok {
		t.Fatal("alpha was not resolved")
	}
}

func TestResolveRejectsProviderForBuiltinType(t *testing.T) {
	builtins := map[reflect.Type]reflect.Value{
		typeOf[alpha](): reflect.ValueOf(&alphaImpl{}),
	}
	newAlpha := func() alpha { return &alphaImpl{} }

	_, err := resolve([]interface{}{newAlpha}, builtins)
	if err == nil {
		t.Fatal("expected error for constructor providing a builtin type, got nil")
	}
	if !strings.Contains(err.Error(), "app.alpha") {
		t.Fatalf("error should name the builtin type, got: %v", err)
	}
}

func TestResolveRejectsInvalidConstructors(t *testing.T) {
	cases := []struct {
		name string
		fn   interface{}
	}{
		{"not a function", 42},
		{"nil", nil},
		{"no return value", func() {}},
		{"multiple return values", func() (alpha, error) { return &alphaImpl{}, nil }},
		{"variadic", func(deps ...alpha) beta { return &betaImpl{} }},
		{"returns concrete struct", func() alphaImpl { return alphaImpl{} }},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := resolve([]interface{}{tc.fn}, nil); err == nil {
				t.Fatalf("expected error for constructor that is %s, got nil", tc.name)
			}
		})
	}
}
