package orders

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/aghchan/simplegoapp/pkg/logger"
)

type Order struct {
	Id       string
	Sku      string
	Quantity int
	Status   string
}

type Service interface {
	Create(ctx context.Context, sku string, quantity int) (Order, error)
	Get(ctx context.Context, id string) (Order, error)
	List(ctx context.Context, limit int, cursor string) ([]Order, string, error)
}

var ErrNotFound = errors.New("order not found")

// NewService returns an in-memory orders store; the reference implementation
// focuses on the API standard, not persistence — real APIs inject
// pkg/postgres or pkg/mongo here instead.
func NewService(logger logger.Logger) Service {
	return &service{logger: logger, byId: map[string]Order{}}
}

type service struct {
	logger logger.Logger

	mu   sync.Mutex
	seq  int
	ids  []string
	byId map[string]Order
}

func (this *service) Create(ctx context.Context, sku string, quantity int) (Order, error) {
	this.mu.Lock()
	defer this.mu.Unlock()

	this.seq++
	order := Order{
		Id:       fmt.Sprintf("ord_%06d", this.seq),
		Sku:      sku,
		Quantity: quantity,
		Status:   "pending",
	}
	this.ids = append(this.ids, order.Id)
	this.byId[order.Id] = order

	return order, nil
}

func (this *service) Get(ctx context.Context, id string) (Order, error) {
	this.mu.Lock()
	defer this.mu.Unlock()

	order, ok := this.byId[id]
	if !ok {
		return Order{}, ErrNotFound
	}

	return order, nil
}

func (this *service) List(ctx context.Context, limit int, cursor string) ([]Order, string, error) {
	this.mu.Lock()
	defer this.mu.Unlock()

	if limit < 1 {
		return []Order{}, "", nil
	}

	// unknown cursors are past-the-end, not page 1: a stale cursor must
	// terminate pagination rather than restart it.
	start := 0
	if cursor != "" {
		start = len(this.ids)
		for i, id := range this.ids {
			if id == cursor {
				start = i + 1
				break
			}
		}
	}

	end := start + limit
	if end > len(this.ids) {
		end = len(this.ids)
	}

	page := make([]Order, 0, end-start)
	for _, id := range this.ids[start:end] {
		page = append(page, this.byId[id])
	}

	next := ""
	if end < len(this.ids) && len(page) > 0 {
		next = page[len(page)-1].Id
	}

	return page, next, nil
}
