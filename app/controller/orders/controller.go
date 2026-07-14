package controller

import (
	"errors"

	apiv1 "github.com/aghchan/simplegoapp/api/v1"
	"github.com/aghchan/simplegoapp/domain/orders"
	"github.com/aghchan/simplegoapp/pkg/http"
	"github.com/aghchan/simplegoapp/pkg/http/apierror"
)

type OrdersController struct {
	http.Controller

	Orders orders.Service
}

func (this *OrdersController) CreateOrder(w http.ResponseWriter, r *http.Request) {
	var req apiv1.CreateOrder
	if err := this.Bind(r, &req); err != nil {
		this.Problem(w, r, err)
		return
	}
	if req.Sku == "" || req.Quantity < 1 {
		this.Problem(w, r, apierror.Invalid("sku is required and quantity must be at least 1"))
		return
	}

	order, err := this.Orders.Create(r.Context(), req.Sku, req.Quantity)
	if err != nil {
		this.Problem(w, r, err)
		return
	}

	w.Header().Set("Location", r.URL.Path+"/"+order.Id)
	this.Respond(w, r, 201, toAPI(order))
}

func (this *OrdersController) GetOrder(w http.ResponseWriter, r *http.Request, orderId string) {
	order, err := this.Orders.Get(r.Context(), orderId)
	if errors.Is(err, orders.ErrNotFound) {
		this.Problem(w, r, apierror.NotFound("order not found"))
		return
	}
	if err != nil {
		this.Problem(w, r, err)
		return
	}

	this.Respond(w, r, 200, toAPI(order))
}

func (this *OrdersController) ListOrders(w http.ResponseWriter, r *http.Request, params apiv1.ListOrdersParams) {
	limit := 20
	if params.Limit != nil {
		limit = *params.Limit
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}

	page, next, err := this.Orders.List(r.Context(), limit, cursor)
	if err != nil {
		this.Problem(w, r, err)
		return
	}

	items := make([]apiv1.Order, len(page))
	for i, order := range page {
		items[i] = toAPI(order)
	}
	this.Respond(w, r, 200, apiv1.OrderList{Items: items, NextCursor: next})
}

func toAPI(order orders.Order) apiv1.Order {
	return apiv1.Order{
		Id:       order.Id,
		Sku:      order.Sku,
		Quantity: order.Quantity,
		Status:   order.Status,
	}
}
