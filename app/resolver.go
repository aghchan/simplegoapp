package app

import (
	"fmt"
	"reflect"
	"strings"
)

type provider struct {
	fn       reflect.Value
	deps     []reflect.Type
	provides reflect.Type
}

// resolve calls each constructor once in dependency order and returns
// singletons keyed by return type, holding the concrete values. builtins are
// injectable without a constructor. Duplicate providers: last registered wins.
func resolve(
	serviceFuncs []interface{},
	builtins map[reflect.Type]reflect.Value,
) (map[reflect.Type]reflect.Value, error) {
	providers := []*provider{}
	indexByType := map[reflect.Type]int{}

	for _, serviceFunc := range serviceFuncs {
		p, err := analyze(serviceFunc)
		if err != nil {
			return nil, err
		}

		if _, ok := builtins[p.provides]; ok {
			return nil, fmt.Errorf(
				"%v is provided by the framework and cannot be registered",
				p.provides,
			)
		}

		if prev, ok := indexByType[p.provides]; ok {
			providers[prev] = nil
		}

		providers = append(providers, p)
		indexByType[p.provides] = len(providers) - 1
	}

	active := []*provider{}
	for _, p := range providers {
		if p != nil {
			active = append(active, p)
		}
	}
	for i, p := range active {
		indexByType[p.provides] = i
	}

	indegree := make([]int, len(active))
	dependents := make([][]int, len(active))
	ready := []int{}

	for i, p := range active {
		for _, dep := range p.deps {
			if _, ok := builtins[dep]; ok {
				continue
			}

			j, ok := indexByType[dep]
			if !ok {
				return nil, fmt.Errorf(
					"%v requires %v, but no constructor provides it",
					p.fn.Type(), dep,
				)
			}

			indegree[i]++
			dependents[j] = append(dependents[j], i)
		}

		if indegree[i] == 0 {
			ready = append(ready, i)
		}
	}

	singletons := make(map[reflect.Type]reflect.Value, len(active)+len(builtins))
	for depType, value := range builtins {
		singletons[depType] = value
	}

	built := 0
	for len(ready) > 0 {
		i := ready[0]
		ready = ready[1:]
		p := active[i]

		args := make([]reflect.Value, len(p.deps))
		for k, dep := range p.deps {
			args[k] = singletons[dep]
		}

		out := p.fn.Call(args)[0]
		if out.Kind() == reflect.Interface {
			out = out.Elem()
		}
		singletons[p.provides] = out
		built++

		for _, d := range dependents[i] {
			if indegree[d]--; indegree[d] == 0 {
				ready = append(ready, d)
			}
		}
	}

	if built != len(active) {
		stuck := []string{}
		for i, p := range active {
			if indegree[i] > 0 {
				stuck = append(stuck, p.provides.String())
			}
		}

		return nil, fmt.Errorf("dependency cycle among: %s", strings.Join(stuck, ", "))
	}

	return singletons, nil
}

func analyze(serviceFunc interface{}) (*provider, error) {
	funcType := reflect.TypeOf(serviceFunc)
	if funcType == nil || funcType.Kind() != reflect.Func {
		return nil, fmt.Errorf("service constructor %v is not a function", serviceFunc)
	}
	if funcType.NumOut() != 1 {
		return nil, fmt.Errorf("constructor %v must return exactly one value", funcType)
	}
	if funcType.IsVariadic() {
		return nil, fmt.Errorf("constructor %v must not be variadic", funcType)
	}

	provides := funcType.Out(0)
	if provides.Kind() != reflect.Interface && provides.Kind() != reflect.Ptr {
		return nil, fmt.Errorf("constructor %v must return an interface or pointer", funcType)
	}

	p := &provider{
		fn:       reflect.ValueOf(serviceFunc),
		provides: provides,
	}
	for i := 0; i < funcType.NumIn(); i++ {
		p.deps = append(p.deps, funcType.In(i))
	}

	return p, nil
}
